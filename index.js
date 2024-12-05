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

const payment = new Payment(client);

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
          success: 'https://sistbar.com/resumen',
          failure: 'https://sistbar.com/homeCliente',
        },
        auto_return: 'approved',
        notification_url: 'https://backbarmp.onrender.com/payment_success',
        external_reference: userId,
        metadata: {
          userId: userId
        }
      }
    });

    // Generar un ID único para la orden de compra
    const orderId = createIdDoc(); // Generar ID de compra

    // Estructura de los datos de la compra que se guardarán en Firestore
    const orderData = {
      userId: userId,
      description: description,
      preferenceId: result?.body?.id || result?.id,
      orderId: orderId,
      telefono: telefono
    };

    // Guardar los datos de la compra en Firestore en la colección "ordenesCompra"
    const orderDoc = firestore.collection('ordenesCompra').doc(orderId);
    await orderDoc.set(orderData);

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
  try {
    const { type, data } = req.body;

    // Verifica si el cuerpo tiene el formato esperado
    if (!data || !data.id) {
      console.error("Invalid webhook payload: Missing 'data.id'");
      return res.status(400).json({ error: "Invalid webhook payload: Missing 'data.id'" });
    }

    const paymentId = data.id;
    console.log("Payment ID received from webhook: ", paymentId);
    console.log("Notification type: ", type);

    // Verifica si la notificación es del tipo "payment"
    if (type !== "payment") {
      console.warn(`Unhandled notification type: ${type}`);
      return res.status(400).json({ error: `Unhandled notification type: ${type}` });
    }

    // Verifica que las credenciales de MercadoPago estén configuradas correctamente
    if (!payment) {
      console.error("MercadoPago SDK not initialized");
      return res.status(500).json({ error: "Internal server error: MercadoPago SDK not initialized" });
    }

    let paymentInfo;
    try {
      // Realiza el get del pago usando el ID recibido
      paymentInfo = await payment.get({ id: paymentId });
      console.log("Payment Info: ", JSON.stringify(paymentInfo, null, 2));
    } catch (error) {
      console.error("Error fetching payment info: ", error);
      return res.status(500).json({ error: "Error fetching payment info" });
    }

    // Verifica que el pago esté aprobado
    if (!paymentInfo || paymentInfo.status !== "approved") {
      console.error("Payment not approved or not found");
      return res.status(400).json({ error: "Payment not approved or not found" });
    }

    const { external_reference, transaction_amount, payer } = paymentInfo;

    if (!external_reference) {
      console.error("No external reference found in payment info");
      return res.status(400).json({ error: "No external reference found in payment info" });
    }

    console.log("External reference: ", external_reference);

    // Buscar la orden en Firestore asociada al usuario con el external_reference y validar estado
    const querySnapshot = await firestore
      .collection("ordenesCompra")
      .where("userId", "==", external_reference) // Buscar órdenes del usuario
      .where("isPaid", "==", false)             // Asegura que no esté pagada
      .where("status", "!=", "completed")       // Asegura que no esté completada
      .get();

    if (querySnapshot.empty) {
      console.error(`No pending order found in Firestore for external_reference: ${external_reference}`);
      return res.status(404).json({ error: "No pending order found" });
    }

    // Suponiendo que solo hay una orden pendiente
    const orderDoc = querySnapshot.docs[0];
    const orderRef = orderDoc.ref;

    // Actualizar la orden con los datos del pago
    await orderRef.update({
      isPaid: true,                   // Marcar como pagada
      paymentDate: new Date(),        // Registrar la fecha del pago
      status: "completed",            // Cambiar el estado a completada
      transactionAmount: transaction_amount, // Monto de la transacción
      payerEmail: payer?.email || null,      // Email del pagador
    });

    console.log(`Order successfully updated in Firestore: ${orderRef.id}`);
    return res.status(200).json({ message: "Payment processed successfully" });
  } catch (error) {
    console.error("Error handling payment webhook: ", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});





// Iniciar el servidor
app.listen(process.env.PORT || 3333, () => {
  console.log("HTTP server running on port:", process.env.PORT || 3333);
});
