
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


app.listen(process.env.PORT || 3000, () => {
  console.log("PayFusion server running");
});
