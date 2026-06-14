
const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static("."));
app.use(express.json());

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);


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



app.listen(process.env.PORT || 3000, () => {
  console.log("PayFusion server running");
});
