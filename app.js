const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();

// Stripe requires raw body for webhook verification
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.log('Webhook signature failed:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  // Handle the events
  switch (event.type) {
    case 'payment_intent.succeeded':
      const pi = event.data.object;
      console.log('Payment succeeded:', pi.id, '$' + pi.amount / 100);
      // TODO: unlock premium for user pi.metadata.userId
      break;
    case 'charge.succeeded':
      console.log('Charge succeeded:', event.data.object.id);
      break;
    case 'checkout.session.completed':
      const session = event.data.object;
      console.log('Checkout complete:', session.id);
      break;
    case 'payment_intent.payment_failed':
      console.log('Payment failed:', event.data.object.id);
      break;
    default:
      console.log('Unhandled event:', event.type);
  }

  res.json({received: true});
});

// Health check
app.get('/', express.json(), (req, res) => {
  res.json({status: 'SpangledAI backend running', timestamp: new Date()});
});

app.use(express.json());
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
