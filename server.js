
const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

const app = express();
app.use(cors());
app.use(express.static("."));
app.use(express.json());

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const BACKEND_URL = process.env.BACKEND_URL;
const FRONTEND_URL = "https://app.usepayfusion.com";
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required"
      });
    }

    const idToken = authHeader.slice(7).trim();

    if (!idToken) {
      return res.status(401).json({
        error: "Authentication required"
      });
    }

    const decodedToken = await getAuth().verifyIdToken(idToken, true);

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || null
    };

    next();
  } catch (error) {
    console.error("Authentication failed:", error.code || "invalid_token");

    return res.status(401).json({
      error: "Invalid or expired authentication"
    });
  }
}
let connectedStripeAccountId = null;
// PayFusion: User-specific Stripe Connect storage

function stripeAccountRef(uid) {
  return db.collection("stripeAccounts").doc(uid);
}

async function getUserStripeAccountId(uid) {
  const snapshot = await stripeAccountRef(uid).get();

  if (!snapshot.exists) {
    return null;
  }

  return snapshot.data().stripeAccountId || null;
}

async function saveUserStripeAccountId(uid, stripeAccountId) {
  await stripeAccountRef(uid).set(
    {
      stripeAccountId,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}
app.get("/firebase-health", async (req, res) => {
  try {
    await db.collection("_health").doc("test").set({
      checkedAt: FieldValue.serverTimestamp()
    });

    res.json({
      firebase: "connected"
    });
  } catch (err) {
    console.error("Firebase health error:", err.message);

    res.status(500).json({
      firebase: "error"
    });
  }
});


app.post("/connect/start", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;

    let stripeAccountId = await getUserStripeAccountId(uid);

    if (!stripeAccountId) {
      const account = await stripe.accounts.create(
        {
          type: "express",
          country: "US",
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true }
          },
          metadata: {
            firebaseUid: uid
          }
        },
        {
          idempotencyKey: `payfusion-connect-${uid}`
        }
      );

      stripeAccountId = account.id;

      await saveUserStripeAccountId(uid, stripeAccountId);
    }

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${BACKEND_URL}/connect/refresh`,
      return_url: `${BACKEND_URL}/connect/return`,
      type: "account_onboarding"
    });

    res.json({
      url: accountLink.url
    });

  } catch (err) {
    console.error("Stripe Connect error:", err.message);

    res.status(500).json({
      error: "Unable to start Stripe onboarding"
    });
  }
});


app.get("/connect/refresh", (req, res) => {
  res.redirect(`${FRONTEND_URL}?stripe_onboarding=refresh`);
});
// PayFusion: Stripe onboarding return
app.get("/connect/return", (req, res) => {
  res.redirect(`${FRONTEND_URL}?stripe_onboarding=return`);
});
// PayFusion: Authenticated Stripe account status
app.get("/connect/status", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;

    const stripeAccountId = await getUserStripeAccountId(uid);

    if (!stripeAccountId) {
      return res.json({
        status: "not_connected"
      });
    }

    const account = await stripe.accounts.retrieve(stripeAccountId);

    return res.json({
      status:
        account.charges_enabled && account.payouts_enabled
          ? "connected"
          : "incomplete",
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled
    });

  } catch (err) {
    console.error("Stripe status error:", err.message);

    return res.status(500).json({
      status: "error"
    });
  }
});
// PayFusion: Create a Fusion Link checkout
app.post("/fusion-links/create", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { amount, description } = req.body;

    const amountCents = Number(amount);

    if (
      !Number.isSafeInteger(amountCents) ||
      amountCents < 50 ||
      amountCents > 100000000
    ) {
      return res.status(400).json({
        error: "Enter a valid amount in cents (minimum 50)."
      });
    }

    const stripeAccountId = await getUserStripeAccountId(uid);

    if (!stripeAccountId) {
      return res.status(400).json({
        error: "Connect your Stripe account first."
      });
    }

    const account = await stripe.accounts.retrieve(stripeAccountId);

    if (!account.charges_enabled) {
      return res.status(400).json({
        error: "Complete Stripe onboarding before creating payment links."
      });
    }

    const paymentDescription =
      typeof description === "string"
        ? description.trim().slice(0, 200)
        : "";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: paymentDescription || "PayFusion Payment"
            }
          },
          quantity: 1
        }
      ],
      payment_intent_data: {
        metadata: {
          firebaseUid: uid
        }
      },
      success_url: `${FRONTEND_URL}/?payment=success`,
      cancel_url: `${FRONTEND_URL}/?payment=cancelled`,
      metadata: {
        firebaseUid: uid
      }
    }, {
      stripeAccount: stripeAccountId
    });

    return res.json({
      url: session.url,
      sessionId: session.id
    });

  } catch (error) {
    console.error("Fusion Links checkout error:", error.message);

    return res.status(500).json({
      error: "Unable to create payment link."
    });
  }
});
// PayFusion: Fusion Book — Create a booking
app.post("/fusion-book/create", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { clientName, service, bookingDate, depositAmount } = req.body || {};

    if (
      typeof clientName !== "string" ||
      !clientName.trim() ||
      typeof service !== "string" ||
      !service.trim() ||
      typeof bookingDate !== "string" ||
      !Number.isFinite(Date.parse(bookingDate)) ||
      !Number.isSafeInteger(depositAmount) ||
      depositAmount < 0
    ) {
      return res.status(400).json({
        error: "Valid client, service, date, and deposit amount are required."
      });
    }

    const bookingRef = db.collection("fusionBookings").doc();

    await bookingRef.set({
      creatorUid: uid,
      clientName: clientName.trim().slice(0, 120),
      service: service.trim().slice(0, 160),
      bookingDate: new Date(bookingDate).toISOString(),
      depositAmount,
      currency: "usd",
      status: "pending",
      paymentStatus: "unpaid",
      createdAt: FieldValue.serverTimestamp()
    });

    return res.status(201).json({
      bookingId: bookingRef.id,
      status: "pending"
    });

  } catch (error) {
    console.error("Fusion Book error:", error.message);
    return res.status(500).json({
      error: "Unable to create booking."
    });
  }
});
// PayFusion: Fusion Deal — Create draft agreement
app.post("/fusion-deal/create", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const {
      clientName,
      dealTitle,
      description,
      amount
    } = req.body || {};

    if (
      typeof clientName !== "string" ||
      !clientName.trim() ||
      typeof dealTitle !== "string" ||
      !dealTitle.trim() ||
      typeof description !== "string" ||
      typeof amount !== "number" ||
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      amount > 100000000
    ) {
      return res.status(400).json({
        error: "Valid client, title, description, and amount are required."
      });
    }

    const dealRef = db.collection("fusionDeals").doc();

    await dealRef.set({
      creatorUid: uid,
      clientName: clientName.trim().slice(0, 120),
      dealTitle: dealTitle.trim().slice(0, 160),
      description: description.trim().slice(0, 2000),
      amount,
      currency: "usd",
      status: "draft",
      paymentStatus: "unpaid",
      createdAt: FieldValue.serverTimestamp()
    });

    return res.status(201).json({
      dealId: dealRef.id,
      status: "draft"
    });

  } catch (error) {
    console.error("Fusion Deal error:", error.message);

    return res.status(500).json({
      error: "Unable to create deal."
    });
  }
});
// PayFusion: Fusion Teams — Create team
app.post("/fusion-teams/create", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { teamName, description } = req.body || {};

    if (
      typeof teamName !== "string" ||
      !teamName.trim() ||
      teamName.trim().length > 120 ||
      (description !== undefined &&
        typeof description !== "string")
    ) {
      return res.status(400).json({
        error: "Enter a valid team name and description."
      });
    }

    const teamRef = db.collection("fusionTeams").doc();

    await teamRef.set({
      ownerUid: uid,
      teamName: teamName.trim(),
      description: (description || "").trim().slice(0, 500),
      status: "active",
      memberCount: 1,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return res.status(201).json({
      teamId: teamRef.id,
      teamName: teamName.trim(),
      status: "active"
    });

  } catch (error) {
    console.error("Fusion Teams error:", error.message);

    return res.status(500).json({
      error: "Unable to create team."
    });
  }
});


app.listen(process.env.PORT || 3000, () => {
  console.log("PayFusion server running");
});
