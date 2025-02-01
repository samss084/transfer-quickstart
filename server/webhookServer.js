const { plaidClient } = require("./plaid");
const db = require("./db");
const { PAYMENT_STATUS } = require("./types");

// Let's define all the valid transitions between payment statuses. It's a 
// simple way to ensure that we're not accidentally updating a payment to an 
// invalid state. (This won't happen in Plaid's system, but it might happen
// in development if you end up re-processing the same batch of events.

const EXPECTED_NEXT_STATES = {
  [PAYMENT_STATUS.NEW]: [PAYMENT_STATUS.PENDING],
  [PAYMENT_STATUS.PENDING]: [
    PAYMENT_STATUS.PENDING,
    PAYMENT_STATUS.FAILED,
    PAYMENT_STATUS.POSTED,
    PAYMENT_STATUS.CANCELLED,
  ],
  [PAYMENT_STATUS.POSTED]: [PAYMENT_STATUS.SETTLED, PAYMENT_STATUS.RETURNED],
  [PAYMENT_STATUS.SETTLED]: [PAYMENT_STATUS.RETURNED],
};

/**
 * Sync all the payment data from Plaid to our database.
 * We'll start from the last sync number we have stored in our database,
 * fetch events in batches of 20, and process them one by one.
 * We'll keep going until the has_more field is false.
 */
async function syncPaymentData() {
  let lastSyncNum =
    (await db.getLastSyncNum()) ?? Number(process.env.START_SYNC_NUM);
  console.log(`Last sync number is ${lastSyncNum}`);

  let fetchMore = true;
  while (fetchMore) {
    const nextBatch = await plaidClient.transferEventSync({
      after_id: lastSyncNum,
      count: 20,
    });
    const sortedEvents = nextBatch.data.transfer_events.sort(
      (a, b) => a.event_id - b.event_id
    );

    for (const event of sortedEvents) {
      await processPaymentEvent(event);
      lastSyncNum = event.event_id;
    }
    // The has_more field was just added in March of 2024!
    fetchMore = nextBatch.data.has_more;
  }
  await db.setLastSyncNum(lastSyncNum);
}

/**
 * Process a /sync event from Plaid. These events are sent to us when a transfer
 * changes status. Typically, they go from `pending` to `posted` to `settled`, 
 * but there are other things that can happen along the way, like a transfer
 * being returned or failing.
 */
const processPaymentEvent = async (event) => {
  console.log(`\n\nAnalyzing event: ${JSON.stringify(event)}`);
  const existingPayment = await db.getPaymentByPlaidId(event.transfer_id);

  if (!existingPayment) {
    console.warn(
      `Could not find a payment with ID ${event.transfer_id}. It might belong to another application`
    );
    return;
  }
  console.log(`Found payment ${JSON.stringify(existingPayment)}`);

  const paymentId = existingPayment.id;
  const billId = existingPayment.bill_id;

  if (!event.event_type in PAYMENT_STATUS) {
    console.error(`Unknown event type ${event.event_type}`);
    return;
  }
  console.log(
    `The payment went from ${existingPayment.status} to ${event.event_type}!`
  );

  if (EXPECTED_NEXT_STATES[existingPayment.status] == null) {
    console.error(`Hmm... existing payment has a status I don't recognize`);
    return;
  }
  if (
    !EXPECTED_NEXT_STATES[existingPayment.status].includes(event.event_type)
  ) {
    // This doesn't normally happen; more likely it'll happen during development when
    // you (intentionally or accidentally) re-process the same batch of events
    console.error(
      `Not sure why a ${existingPayment.status} payment going to a ${event.event_type} state. Skipping`
    );
    return;
  }
  console.log(`Updating the payment status to ${event.event_type}`);
  const errorMessage = event.failure_reason?.description ?? "";
  await db.updatePaymentStatus(
    paymentId,
    event.event_type,
    billId,
    errorMessage
  );
};

module.exports = { syncPaymentData, PAYMENT_STATUS };

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { syncPaymentData } = require("./syncPaymentData");

/**
 * Our server running on a different port that we'll use for handling webhooks.
 * We run this on a separate port so that it's easier to expose just this
 * server to the world using ngrok
 */
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 8001;

const webhookApp = express();
webhookApp.use(bodyParser.urlencoded({ extended: false }));
webhookApp.use(bodyParser.json());

const webhookServer = webhookApp.listen(WEBHOOK_PORT, function () {
  console.log(
    `Webhook receiver is up and running at http://localhost:${WEBHOOK_PORT}/`
  );
});

/**
 * This is our endpoint to receive webhooks from Plaid. We look at the 
 * webhook_type (which represents the product) and then decide what function
 * to call from there.
 */
webhookApp.post("/server/receive_webhook", async (req, res, next) => {
  try {
    console.log("**INCOMING WEBHOOK**");
    console.dir(req.body, { colors: true, depth: null });
    const product = req.body.webhook_type;
    const code = req.body.webhook_code;
    // TODO (maybe): Verify webhook
    switch (product) {
      case "ITEM":
        handleItemWebhook(code, req.body);
        break;
      case "TRANSFER":
        handleTransferWebhook(code, req.body);
        break;
      default:
        console.log(`Can't handle webhook product ${product}`);
        break;
    }
    res.json({ status: "received" });
  } catch (error) {
    next(error);
  }
});

/**
 * Handle webhooks related to individual Items
 */
function handleItemWebhook(code, requestBody) {
  switch (code) {
    case "ERROR":
      console.log(
        `I received this error: ${requestBody.error.error_message}| should probably ask this user to connect to their bank`
      );
      break;
    case "NEW_ACCOUNTS_AVAILABLE":
      console.log(
        `There are new accounts available at this Financial Institution! (Id: ${requestBody.item_id}) We may want to ask the user to share them with us`
      );
      break;
    case "PENDING_EXPIRATION":
    case "PENDING_DISCONNECT":
      console.log(
        `We should tell our user to reconnect their bank with Plaid so there's no disruption to their service`
      );
      break;
    case "USER_PERMISSION_REVOKED":
      console.log(
        `The user revoked access to this item. We should remove it from our records`
      );
      break;
    case "WEBHOOK_UPDATE_ACKNOWLEDGED":
      console.log(`Hooray! You found the right spot!`);
      break;
    default:
      console.log(`Can't handle webhook code ${code}`);
      break;
  }
}

/**
 * Handle webhooks related to Transfers. The most important for our app is the
 * TRANSFER_EVENTS_UPDATE webhook, which tells us when the status of a transfer
 * has changed. (Note that the webhook doesn't tell us _which_ transfer has 
 * changed, but that's okay. Calling /transfer/event/sync will give us the 
 * latest status updates of all transfers.)
 */

function handleTransferWebhook(code, requestBody) {
  switch (code) {
    case "TRANSFER_EVENTS_UPDATE":
      console.log(`Looks like we have some new transfer events to process`);
      syncPaymentData();
      break;
    case "RECURRING_NEW_TRANSFER":
    case "RECURRING_TRANSFER_SKIPPED":
    case "RECURRING_CANCELLED":
      console.log(
        `Received a ${code} event, which is weird because this app doesn't support recurring transfers`
      );
      break;
    default:
      console.log(`Can't handle webhook code ${code}`);
      break;
  }
}

/**
 * Add in some basic error handling so our server doesn't crash if we run into
 * an error.
 */
const errorHandler = function (err, req, res, next) {
  console.error(`Your error:`);
  console.error(err);
  if (err.response?.data != null) {
    res.status(500).send(err.response.data);
  } else {
    res.status(500).send({
      error_code: "OTHER_ERROR",
      error_message: "I got some other message on the server.",
    });
  }
};
webhookApp.use(errorHandler);

const getWebhookServer = function () {
  return webhookServer;
};

module.exports = {
  getWebhookServer,
};
