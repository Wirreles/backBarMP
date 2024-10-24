import express from 'express';
import cors from 'cors';
import { initializeApp } from 'firebase-admin/app'; // Puedes usar esto si sigues con import, pero...
import admin from 'firebase-admin';  // Aquí necesitas `require` para Firebase
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';
// import googleCredentials from './utils/bartest-ea852-2910d20fc320.json' assert { type: 'json' }; 
// Cargar variables de entorno
dotenv.config();
// Inicializar Firebase Admin SDK
// admin.initializeApp({
//   credential: admin.credential.cert(googleCredentials)
// });

const serviceAccount = JSON.parse(readFileSync('/etc/secrets/bartest-ea852-2910d20fc320.json', 'utf-8'));
// Inicializar Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


const firestore = admin.firestore();

// SDK de Mercado Pago
const client = new MercadoPagoConfig({ 
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN
});

const app = express();
const corsOptions = {
  origin: '*', // Cambia esto por el dominio permitido o usa '*' para todos.
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true // Permite incluir cookies si es necesario
};

app.options('*', cors(corsOptions));  // Permitir CORS en las solicitudes preflight
app.use(cors(corsOptions)); // Habilita CORS con opciones
app.use(express.json());

// Ruta para crear la preferencia de pago
app.post('/create_preference', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Recibir description, totalAmount, currency_id, y userId desde el cuerpo de la solicitud
  const { description, totalAmount, currency_id, userId, telefono } = req.body;

  try {
    // Crear la preferencia de pago para MercadoPago
    const preference = new Preference(client);

    const result = await preference.create({
      body: {
        items: [
          {
            title: description,
            quantity: 1,
            unit_price: totalAmount,
            currency_id: currency_id,
          },
        ],
        back_urls: {
          success: 'gestion-bares.vercel.app/resumen',
          failure: 'gestion-bares.vercel.app/homeCliente',
        },
        auto_return: 'approved',
        notification_url: 'https://backbarmp.onrender.com/payment_success',
      }
    });

    // Generar un ID único para la orden de compra
    const orderId = createIdDoc(); // Generar ID de compra

    // Estructura de los datos de la compra que se guardarán en Firestore
    const orderData = {
      userId: userId,
      description: description,
      totalAmount: totalAmount,
      currency_id: currency_id,
      isPaid: false,
      preferenceId: result?.body?.id || result?.id,
      status: 'pending',
      orderId: orderId,
      telefono: telefono
    };

    // Guardar los datos de la compra en Firestore en la colección "ordenesCompra"
    const orderDoc = firestore.collection('ordenesCompra').doc(orderId);
    await orderDoc.set(orderData);

    // Guardar datos en tempStorage
    const tempData = {
      userId: userId,
      totalAmount: totalAmount,
      orderId: orderId,
      preferenceId: result?.body?.id || result?.id
    };

    const tempDoc = firestore.collection('tempStorage').doc(orderId);
    await tempDoc.set(tempData);

    // Enviar la preferencia de MercadoPago y el ID de la orden al front-end
    return res.json({
      ...result,
      orderId: orderId // Incluir el orderId en la respuesta
    });
  } catch (error) {
    console.error('Error al crear la preferencia:', error);
    return res.status(500).json({ error: 'Error al crear la preferencia de pago' });
  }
});



// Implementación de la función para generar un ID único (similar a createIdDoc)
function createIdDoc() {
  return firestore.collection('dummyCollection').doc().id; // Usamos un doc temporal para generar el ID
}




// Ruta para manejar el pago exitoso
app.post('/payment_success', async (req, res) => {
  const dataId = req.query['id'];  // MercadoPago envía el ID del recurso
  const type1 = req.query['topic'];  // MercadoPago envía el tipo de notificación en 'topic'
  console.log("Payment success notification:", dataId, type1);

  if (type1 === 'payment') {
    try {
      // Buscar el pago en Mercado Pago usando el ID
      const payment = new Payment(client);
      const response = await payment.search(dataId);

      if (!response || !response.results || response.results.length === 0) {
        return res.status(404).json({ error: 'Payment not found' });
      }

      // Recuperar el documento temporal en tempStorage por medio del paymentId o algún otro identificador
      const tempDataSnap = await firestore.collection('tempStorage').limit(1).get();

      if (tempDataSnap.empty) {
        return res.status(404).json({ error: 'No temp data found' });
      }

      // Acceder al primer documento (el único esperado)
      const tempDoc = tempDataSnap.docs[0];
      const tempData = tempDoc.data();

      // Extraer el orderId de tempStorage
      const { orderId, userId } = tempData;
      console.log("order ID = " + orderId)
      // Actualizar los campos de la orden en Firestore usando el orderId
      const orderRef = firestore.collection('ordenesCompra').doc(orderId);
      await orderRef.update({
        isPaid: true,                   // El pago fue realizado exitosamente
        paymentDate: new Date(),        // Fecha de pago
        status: 'completed'             // Actualizar el estado a 'completed'
      });

      console.log("Deleting temp document with ID:", tempDoc.id);
      await firestore.collection('tempStorage').doc(tempDoc.id).delete();


      return res.status(200).json({ message: 'Payment processed successfully' });
    } catch (error) {
      console.error('Failed to process payment:', error);
      return res.status(500).json({ error: 'Failed to process payment' });
    }
  } else {
    return res.status(400).json({ error: 'Invalid payment type' });
  }
});





// Iniciar el servidor
app.listen(process.env.PORT || 3333, () => {
  console.log("HTTP server running on port:", process.env.PORT || 3333);
});
