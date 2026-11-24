# @cloudfarm/stripe

Payments. Look up and create customers, list charges, read the account balance, and refund a charge.

Generated from `tools/integration-codegen/specs/stripe.mjs`. Edit the spec and run
`pnpm gen:integrations`; `src/` is overwritten, so hand edits there are lost.

## Credentials

Use a restricted key from the Stripe dashboard under Developers → API keys. Give it read access to customers and charges, and write access only if an agent should create customers or issue refunds — a restricted key is the whole reason an agent does not need the secret key. See [the upstream docs](https://docs.stripe.com/api).

The credential is held by the auth scheme and applied per request. No action
handler, result, or code-mode script can read it, and `allowedHosts` keeps a
credentialed request from being redirected off `api.stripe.com` by a URL that
arrived in a model's arguments.

## Usage

```ts
import { Computer } from "@cloudfarm/computer";
import { stripe } from "@cloudfarm/stripe";

const computer = new Computer({
  apps: [stripe({ apiKey: process.env.STRIPE_API_KEY! })],
});
```

## Actions

| ref                              | what it does                                               | effects     |
| -------------------------------- | ---------------------------------------------------------- | ----------- |
| `stripe.listCustomers`           | List customers, newest first, or look one up by email.     | read        |
| `stripe.searchCustomers`         | Search customers with Stripe's query language.             | read        |
| `stripe.createCustomer`          | Create a customer record.                                  | write       |
| `stripe.listCharges`             | List charges, newest first, optionally for one customer.   | read        |
| `stripe.getBalance`              | Read the account balance, available and pending.           | read        |
| `stripe.refundCharge`            | Refund a charge, fully or in part.                         | destructive |
| `stripe.getCustomer`             | Read one customer by id.                                   | read        |
| `stripe.updateCustomer`          | Change a customer's email, name or description.            | write       |
| `stripe.listSubscriptions`       | List subscriptions, optionally for one customer or status. | read        |
| `stripe.getSubscription`         | Read one subscription, with its plan and billing period.   | read        |
| `stripe.cancelSubscription`      | Cancel a subscription immediately.                         | destructive |
| `stripe.listInvoices`            | List invoices, optionally for one customer or status.      | read        |
| `stripe.getInvoice`              | Read one invoice.                                          | read        |
| `stripe.listPaymentIntents`      | List payment intents, newest first.                        | read        |
| `stripe.getPaymentIntent`        | Read one payment intent, with why it failed if it did.     | read        |
| `stripe.listProducts`            | List products in the catalogue.                            | read        |
| `stripe.listPrices`              | List prices, optionally for one product.                   | read        |
| `stripe.createPaymentLink`       | Create a shareable payment link for a price.               | write       |
| `stripe.getCharge`               | Read one charge.                                           | read        |
| `stripe.searchCharges`           | Search charges with Stripe's query language.               | read        |
| `stripe.listRefunds`             | List refunds, optionally for one charge.                   | read        |
| `stripe.listPayouts`             | List payouts to the bank account.                          | read        |
| `stripe.listDisputes`            | List disputes and chargebacks.                             | read        |
| `stripe.listBalanceTransactions` | List balance transactions, with fees and net amounts.      | read        |
| `stripe.listEvents`              | List recent account events, newest first.                  | read        |

Every action goes through `context.http`, so a non-2xx arrives as an `HttpError`
carrying its status: a 429 reaches the model as a retryable rate limit rather
than a permanent fault. Runs on Node **and** Workers — it uses nothing but
`fetch`.
