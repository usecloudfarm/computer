---
title: Stripe
description: Payments. Look up and create customers, list charges, read the account balance, and refund a charge.
app:
  package: "@cloudfarm/stripe"
  icon: "https://cdn.simpleicons.org/stripe"
  credential: api-key
  mark: St
---

## Install

```bash
pnpm add @cloudfarm/stripe
```

## Connect

```ts
import { stripe } from "@cloudfarm/stripe";

const computer = new Computer({
  apps: [
    stripe({
      apiKey: process.env.STRIPE_API_KEY,
    }),
  ],
});
```

Use a restricted key from the Stripe dashboard under Developers → API keys. Give it read access to customers and charges, and write access only if an agent should create customers or issue refunds — a restricted key is the whole reason an agent does not need the secret key.

| Option   | Type     | Notes                                                      |
| -------- | -------- | ---------------------------------------------------------- |
| `apiKey` | `string` | Required. A Stripe secret or restricted key (sk_… / rk_…). |

Requests may only reach `api.stripe.com`.

## What the agent can do

| Action                           | Does                                                      | Writes |
| -------------------------------- | --------------------------------------------------------- | ------ |
| `stripe.listCustomers`           | List customers, newest first, or look one up by email     | no     |
| `stripe.searchCustomers`         | Search customers with Stripe's query language             | no     |
| `stripe.createCustomer`          | Create a customer record                                  | yes    |
| `stripe.listCharges`             | List charges, newest first, optionally for one customer   | no     |
| `stripe.getBalance`              | Read the account balance, available and pending           | no     |
| `stripe.refundCharge`            | Refund a charge, fully or in part                         | yes    |
| `stripe.getCustomer`             | Read one customer by id                                   | no     |
| `stripe.updateCustomer`          | Change a customer's email, name or description            | yes    |
| `stripe.listSubscriptions`       | List subscriptions, optionally for one customer or status | no     |
| `stripe.getSubscription`         | Read one subscription, with its plan and billing period   | no     |
| `stripe.cancelSubscription`      | Cancel a subscription immediately                         | yes    |
| `stripe.listInvoices`            | List invoices, optionally for one customer or status      | no     |
| `stripe.getInvoice`              | Read one invoice                                          | no     |
| `stripe.listPaymentIntents`      | List payment intents, newest first                        | no     |
| `stripe.getPaymentIntent`        | Read one payment intent, with why it failed if it did     | no     |
| `stripe.listProducts`            | List products in the catalogue                            | no     |
| `stripe.listPrices`              | List prices, optionally for one product                   | no     |
| `stripe.createPaymentLink`       | Create a shareable payment link for a price               | yes    |
| `stripe.getCharge`               | Read one charge                                           | no     |
| `stripe.searchCharges`           | Search charges with Stripe's query language               | no     |
| `stripe.listRefunds`             | List refunds, optionally for one charge                   | no     |
| `stripe.listPayouts`             | List payouts to the bank account                          | no     |
| `stripe.listDisputes`            | List disputes and chargebacks                             | no     |
| `stripe.listBalanceTransactions` | List balance transactions, with fees and net amounts      | no     |
| `stripe.listEvents`              | List recent account events, newest first                  | no     |

```ts
run({ ref: "stripe.listCustomers", args: {} });
run({ ref: "stripe.createCustomer", args: { email: "…" } });
```

## Notes

Stripe's API predates JSON bodies: writes are form-encoded, which is why
the write actions use `form` rather than `body`. Core encodes it and drops
absent fields, so an optional argument the model left out is simply not
sent rather than sent as the string "undefined".

`refundCharge` is marked destructive, not merely a write: it moves money,
and the distinction is what lets a host require approval for exactly that
action while leaving reads alone.

Upstream API docs: <https://docs.stripe.com/api>
