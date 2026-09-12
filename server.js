
const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static("."));
app.use(express.json());

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
let connectedStripeAccountId = null;


app.get("/connect/start", async (req, res) => {
  try {
    const account = await stripe.accounts.create({
      type: "express",
      country: "US",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      }
    });
    connectedStripeAccountId = account.id;

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: "https://payfusion-api-jw97.onrender.com/connect/refresh",
      return_url: "https://payfusion-api-jw97.onrender.com/connect/return",
      type: "account_onboarding"
    });

    res.redirect(accountLink.url);
  } catch (err) {
    console.error("Stripe Connect error:", err.message);
    res.status(500).send("Stripe Connect error: " + err.message);
  }
});



app.get("/connect/refresh", (req, res) => {
  res.redirect("/connect/start");
});

app.get("/connect/return", (req, res) => {
  res.send(`
    <h1>Stripe Connected Successfully ✅</h1>
    <p>You can now return to PayFusion.</p>
    <a href="https://app.usepayfusion.com">Back to PayFusion</a>
  `);
});
app.get("/connect/status", async (req, res) => {
  try {
    if (!connectedStripeAccountId) {
      return res.json({
        status: "not_connected"
      });
    }

    const account = await stripe.accounts.retrieve(
      connectedStripeAccountId
    );

    if (account.charges_enabled && account.payouts_enabled) {
      return res.json({
        status: "connected",
        charges_enabled: true,
        payouts_enabled: true
      });
    }

    return res.json({
      status: "incomplete",
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled
    });

  } catch (err) {
    console.error("Stripe status error:", err.message);

    res.status(500).json({
      status: "error"
    });
  }
});



app.listen(process.env.PORT || 3000, () => {
  console.log("PayFusion server running");
});
