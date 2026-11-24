/** Stripe: customers, charges, balance and refunds. */
export default {
  id: "stripe",
  name: "Stripe",
  description:
    "Payments. Look up and create customers, list charges, read the account balance, and refund a charge.",
  npmDescription: "Stripe as a Computer app: customers, charges, balance and refunds",
  icon: "https://cdn.simpleicons.org/stripe",
  docsUrl: "https://docs.stripe.com/api",
  credentials:
    "Use a restricted key from the Stripe dashboard under Developers → API keys. Give it read access to customers and charges, and write access only if an agent should create customers or issue refunds — a restricted key is the whole reason an agent does not need the secret key.",
  auth: { kind: "apiKey", describe: "A Stripe secret or restricted key (sk_… / rk_…)." },
  baseUrl: "https://api.stripe.com/v1",
  allowedHosts: ["api.stripe.com"],
  notes: [
    "Stripe's API predates JSON bodies: writes are form-encoded, which is why",
    "the write actions use `form` rather than `body`. Core encodes it and drops",
    "absent fields, so an optional argument the model left out is simply not",
    'sent rather than sent as the string "undefined".',
    "",
    "`refundCharge` is marked destructive, not merely a write: it moves money,",
    "and the distinction is what lets a host require approval for exactly that",
    "action while leaving reads alone.",
  ],
  actions: [
    {
      name: "listCustomers",
      summary: "List customers, newest first, or look one up by email.",
      useCases: [
        "list customers",
        "find a customer by email",
        "who signed up recently",
        "look up a stripe customer",
      ],
      keywords: ["account", "subscriber", "billing"],
      sideEffects: "read",
      input: {
        email: { type: "string", optional: true, describe: "Exact match on the customer email." },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: { method: "GET", path: "customers", query: { email: "$email", limit: "$limit" } },
      output: {
        type: "object",
        fields: {
          customers: {
            type: "array",
            from: "data",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                email: { type: "string", optional: true },
                name: { type: "string", optional: true },
                created: { type: "number", describe: "Unix seconds." },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: [{ id: "cus_1", email: "ada@example.com", name: "Ada", created: 1764000000 }],
      },
      expect: {
        customers: [{ id: "cus_1", email: "ada@example.com", name: "Ada", created: 1764000000 }],
      },
    },

    {
      name: "searchCustomers",
      summary: "Search customers with Stripe's query language.",
      useCases: [
        "search customers",
        "find customers whose name contains",
        "search stripe by metadata",
      ],
      sideEffects: "read",
      input: {
        query: {
          type: "string",
          min: 1,
          describe: "Stripe search syntax, e.g. \"name:'Ada' AND metadata['plan']:'pro'\".",
        },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: {
        method: "GET",
        path: "customers/search",
        query: { query: "$query", limit: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          customers: {
            type: "array",
            from: "data",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                email: { type: "string", optional: true },
                name: { type: "string", optional: true },
              },
            },
          },
        },
      },
      args: { query: "name:'Ada'" },
      sample: { data: [{ id: "cus_1", email: "ada@example.com", name: "Ada" }] },
      expect: { customers: [{ id: "cus_1", email: "ada@example.com", name: "Ada" }] },
    },

    {
      name: "createCustomer",
      summary: "Create a customer record.",
      useCases: ["create a customer", "add a customer to stripe", "register a new account"],
      sideEffects: "write",
      input: {
        email: { type: "string", describe: "Billing email." },
        name: { type: "string", optional: true },
        description: { type: "string", optional: true },
      },
      request: {
        method: "POST",
        path: "customers",
        form: { email: "$email", name: "$name", description: "$description" },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          email: { type: "string", optional: true },
          created: { type: "number" },
        },
      },
      args: { email: "ada@example.com", name: "Ada" },
      sample: { id: "cus_2", email: "ada@example.com", created: 1764000100 },
      expect: { id: "cus_2", email: "ada@example.com", created: 1764000100 },
    },

    {
      name: "listCharges",
      summary: "List charges, newest first, optionally for one customer.",
      useCases: [
        "list charges",
        "what did this customer pay",
        "recent payments",
        "show failed payments",
      ],
      keywords: ["payment", "transaction", "revenue"],
      sideEffects: "read",
      input: {
        customer: { type: "string", optional: true, describe: "Customer id to filter by." },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: {
        method: "GET",
        path: "charges",
        query: { customer: "$customer", limit: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          charges: {
            type: "array",
            from: "data",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                amount: { type: "number", describe: "In the currency's smallest unit." },
                currency: { type: "string" },
                status: { type: "string" },
                paid: { type: "boolean" },
                customer: { type: "string", optional: true },
                description: { type: "string", optional: true },
                receiptUrl: { type: "string", from: "receipt_url", optional: true },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: [
          {
            id: "ch_1",
            amount: 4900,
            currency: "usd",
            status: "succeeded",
            paid: true,
            customer: "cus_1",
            description: "Pro plan",
            receipt_url: "https://pay.stripe.com/receipts/ch_1",
          },
        ],
      },
      expect: {
        charges: [
          {
            id: "ch_1",
            amount: 4900,
            currency: "usd",
            status: "succeeded",
            paid: true,
            customer: "cus_1",
            description: "Pro plan",
            receiptUrl: "https://pay.stripe.com/receipts/ch_1",
          },
        ],
      },
    },

    {
      name: "getBalance",
      summary: "Read the account balance, available and pending.",
      useCases: [
        "what is my stripe balance",
        "how much is available to pay out",
        "account balance",
      ],
      sideEffects: "read",
      input: {},
      request: { method: "GET", path: "balance" },
      output: {
        type: "object",
        fields: {
          available: {
            type: "array",
            item: {
              type: "object",
              fields: { amount: { type: "number" }, currency: { type: "string" } },
            },
          },
          pending: {
            type: "array",
            item: {
              type: "object",
              fields: { amount: { type: "number" }, currency: { type: "string" } },
            },
          },
        },
      },
      args: {},
      sample: {
        available: [{ amount: 125000, currency: "usd" }],
        pending: [{ amount: 4900, currency: "usd" }],
      },
      expect: {
        available: [{ amount: 125000, currency: "usd" }],
        pending: [{ amount: 4900, currency: "usd" }],
      },
    },

    {
      name: "refundCharge",
      summary: "Refund a charge, fully or in part.",
      useCases: ["refund a charge", "give a customer their money back", "issue a partial refund"],
      sideEffects: "destructive",
      input: {
        charge: { type: "string", describe: "Charge id to refund." },
        amount: {
          type: "int",
          min: 1,
          optional: true,
          describe: "Smallest currency unit; omit to refund the whole charge.",
        },
      },
      request: { method: "POST", path: "refunds", form: { charge: "$charge", amount: "$amount" } },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          status: { type: "string" },
          amount: { type: "number" },
        },
      },
      args: { charge: "ch_1" },
      sample: { id: "re_1", status: "succeeded", amount: 4900 },
      expect: { id: "re_1", status: "succeeded", amount: 4900 },
    },
    {
      name: "getCustomer",
      summary: "Read one customer by id.",
      useCases: ["read a stripe customer", "look up a customer by id", "customer details"],
      sideEffects: "read",
      input: { customerId: { type: "string" } },
      request: { method: "GET", path: "customers/{customerId}" },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          email: { type: "string", optional: true },
          name: { type: "string", optional: true },
          balance: { type: "number", describe: "Credit balance, smallest currency unit." },
          delinquent: { type: "boolean", optional: true },
          created: { type: "number" },
        },
      },
      args: { customerId: "cus_1" },
      sample: {
        id: "cus_1",
        email: "ada@example.com",
        name: "Ada",
        balance: 0,
        delinquent: false,
        created: 1764000000,
      },
      expect: {
        id: "cus_1",
        email: "ada@example.com",
        name: "Ada",
        balance: 0,
        delinquent: false,
        created: 1764000000,
      },
    },

    {
      name: "updateCustomer",
      summary: "Change a customer's email, name or description.",
      useCases: ["update a customer", "change a customer email", "rename a stripe customer"],
      sideEffects: "write",
      input: {
        customerId: { type: "string" },
        email: { type: "string", optional: true },
        name: { type: "string", optional: true },
        description: { type: "string", optional: true },
      },
      request: {
        method: "POST",
        path: "customers/{customerId}",
        form: { email: "$email", name: "$name", description: "$description" },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          email: { type: "string", optional: true },
          name: { type: "string", optional: true },
        },
      },
      args: { customerId: "cus_1", name: "Ada L." },
      sample: { id: "cus_1", email: "ada@example.com", name: "Ada L." },
      expect: { id: "cus_1", email: "ada@example.com", name: "Ada L." },
    },

    {
      name: "listSubscriptions",
      summary: "List subscriptions, optionally for one customer or status.",
      useCases: [
        "list subscriptions",
        "who is subscribed",
        "what plan is this customer on",
        "show active subscriptions",
        "which subscriptions are past due",
      ],
      keywords: ["plan", "recurring", "mrr"],
      sideEffects: "read",
      input: {
        customer: { type: "string", optional: true, describe: "Customer id to filter by." },
        status: {
          type: "string",
          optional: true,
          describe: 'e.g. "active", "past_due", "canceled", "trialing", or "all".',
        },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: {
        method: "GET",
        path: "subscriptions",
        query: { customer: "$customer", status: "$status", limit: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          subscriptions: {
            type: "array",
            from: "data",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                status: { type: "string" },
                customer: { type: "string" },
                // Stripe moved the billing period onto the item; it is not on
                // the subscription itself in current API versions.
                currentPeriodEnd: {
                  type: "number",
                  from: "items.data.0.current_period_end",
                  optional: true,
                },
                priceId: { type: "string", from: "items.data.0.price.id", optional: true },
                cancelAtPeriodEnd: { type: "boolean", from: "cancel_at_period_end" },
                created: { type: "number" },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: [
          {
            id: "sub_1",
            status: "active",
            customer: "cus_1",
            cancel_at_period_end: false,
            created: 1764000000,
            items: { data: [{ current_period_end: 1766592000, price: { id: "price_1" } }] },
          },
        ],
      },
      expect: {
        subscriptions: [
          {
            id: "sub_1",
            status: "active",
            customer: "cus_1",
            currentPeriodEnd: 1766592000,
            priceId: "price_1",
            cancelAtPeriodEnd: false,
            created: 1764000000,
          },
        ],
      },
    },

    {
      name: "getSubscription",
      summary: "Read one subscription, with its plan and billing period.",
      useCases: ["read a subscription", "when does this subscription renew", "what plan is this"],
      sideEffects: "read",
      input: { subscriptionId: { type: "string" } },
      request: { method: "GET", path: "subscriptions/{subscriptionId}" },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          status: { type: "string" },
          customer: { type: "string" },
          currentPeriodEnd: {
            type: "number",
            from: "items.data.0.current_period_end",
            optional: true,
          },
          priceId: { type: "string", from: "items.data.0.price.id", optional: true },
          cancelAtPeriodEnd: { type: "boolean", from: "cancel_at_period_end" },
        },
      },
      args: { subscriptionId: "sub_1" },
      sample: {
        id: "sub_1",
        status: "active",
        customer: "cus_1",
        cancel_at_period_end: false,
        items: { data: [{ current_period_end: 1766592000, price: { id: "price_1" } }] },
      },
      expect: {
        id: "sub_1",
        status: "active",
        customer: "cus_1",
        currentPeriodEnd: 1766592000,
        priceId: "price_1",
        cancelAtPeriodEnd: false,
      },
    },

    {
      name: "cancelSubscription",
      summary: "Cancel a subscription immediately.",
      useCases: ["cancel a subscription", "end someone's plan", "stop billing this customer"],
      sideEffects: "destructive",
      input: { subscriptionId: { type: "string" } },
      request: { method: "DELETE", path: "subscriptions/{subscriptionId}" },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          status: { type: "string" },
          canceledAt: { type: "number", from: "canceled_at", optional: true },
        },
      },
      args: { subscriptionId: "sub_1" },
      sample: { id: "sub_1", status: "canceled", canceled_at: 1764003600 },
      expect: { id: "sub_1", status: "canceled", canceledAt: 1764003600 },
    },

    {
      name: "listInvoices",
      summary: "List invoices, optionally for one customer or status.",
      useCases: [
        "list invoices",
        "what invoices are unpaid",
        "this customer's invoices",
        "show open invoices",
      ],
      keywords: ["billing", "receipt", "unpaid"],
      sideEffects: "read",
      input: {
        customer: { type: "string", optional: true },
        status: {
          type: "enum",
          values: ["draft", "open", "paid", "uncollectible", "void"],
          optional: true,
        },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: {
        method: "GET",
        path: "invoices",
        query: { customer: "$customer", status: "$status", limit: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          invoices: {
            type: "array",
            from: "data",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                number: { type: "string", optional: true },
                status: { type: "string", optional: true },
                amountDue: { type: "number", from: "amount_due" },
                amountPaid: { type: "number", from: "amount_paid" },
                currency: { type: "string" },
                customer: { type: "string", optional: true },
                url: { type: "string", from: "hosted_invoice_url", optional: true },
                created: { type: "number" },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: [
          {
            id: "in_1",
            number: "ACME-0001",
            status: "open",
            amount_due: 4900,
            amount_paid: 0,
            currency: "usd",
            customer: "cus_1",
            hosted_invoice_url: "https://invoice.stripe.com/i/in_1",
            created: 1764000000,
          },
        ],
      },
      expect: {
        invoices: [
          {
            id: "in_1",
            number: "ACME-0001",
            status: "open",
            amountDue: 4900,
            amountPaid: 0,
            currency: "usd",
            customer: "cus_1",
            url: "https://invoice.stripe.com/i/in_1",
            created: 1764000000,
          },
        ],
      },
    },

    {
      name: "getInvoice",
      summary: "Read one invoice.",
      useCases: ["read an invoice", "is this invoice paid", "invoice details"],
      sideEffects: "read",
      input: { invoiceId: { type: "string" } },
      request: { method: "GET", path: "invoices/{invoiceId}" },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          number: { type: "string", optional: true },
          status: { type: "string", optional: true },
          amountDue: { type: "number", from: "amount_due" },
          amountPaid: { type: "number", from: "amount_paid" },
          currency: { type: "string" },
          url: { type: "string", from: "hosted_invoice_url", optional: true },
        },
      },
      args: { invoiceId: "in_1" },
      sample: {
        id: "in_1",
        number: "ACME-0001",
        status: "paid",
        amount_due: 4900,
        amount_paid: 4900,
        currency: "usd",
        hosted_invoice_url: "https://invoice.stripe.com/i/in_1",
      },
      expect: {
        id: "in_1",
        number: "ACME-0001",
        status: "paid",
        amountDue: 4900,
        amountPaid: 4900,
        currency: "usd",
        url: "https://invoice.stripe.com/i/in_1",
      },
    },

    {
      name: "listPaymentIntents",
      summary: "List payment intents, newest first.",
      useCases: ["list payment intents", "what payments are pending", "failed payment attempts"],
      sideEffects: "read",
      input: {
        customer: { type: "string", optional: true },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: {
        method: "GET",
        path: "payment_intents",
        query: { customer: "$customer", limit: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          paymentIntents: {
            type: "array",
            from: "data",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                amount: { type: "number" },
                currency: { type: "string" },
                status: { type: "string" },
                customer: { type: "string", optional: true },
                description: { type: "string", optional: true },
                created: { type: "number" },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: [
          {
            id: "pi_1",
            amount: 4900,
            currency: "usd",
            status: "requires_payment_method",
            customer: "cus_1",
            description: "Pro plan",
            created: 1764000000,
          },
        ],
      },
      expect: {
        paymentIntents: [
          {
            id: "pi_1",
            amount: 4900,
            currency: "usd",
            status: "requires_payment_method",
            customer: "cus_1",
            description: "Pro plan",
            created: 1764000000,
          },
        ],
      },
    },

    {
      name: "getPaymentIntent",
      summary: "Read one payment intent, with why it failed if it did.",
      useCases: ["why did this payment fail", "read a payment intent", "payment status"],
      sideEffects: "read",
      input: { paymentIntentId: { type: "string" } },
      request: { method: "GET", path: "payment_intents/{paymentIntentId}" },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string" },
          status: { type: "string" },
          customer: { type: "string", optional: true },
          lastError: { type: "string", from: "last_payment_error.message", optional: true },
        },
      },
      args: { paymentIntentId: "pi_1" },
      sample: {
        id: "pi_1",
        amount: 4900,
        currency: "usd",
        status: "requires_payment_method",
        customer: "cus_1",
        last_payment_error: { message: "Your card was declined." },
      },
      expect: {
        id: "pi_1",
        amount: 4900,
        currency: "usd",
        status: "requires_payment_method",
        customer: "cus_1",
        lastError: "Your card was declined.",
      },
    },

    {
      name: "listProducts",
      summary: "List products in the catalogue.",
      useCases: ["list products", "what do we sell", "show the stripe catalogue"],
      sideEffects: "read",
      input: {
        active: { type: "boolean", optional: true },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: { method: "GET", path: "products", query: { active: "$active", limit: "$limit" } },
      output: {
        type: "object",
        fields: {
          products: {
            type: "array",
            from: "data",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                name: { type: "string" },
                description: { type: "string", optional: true },
                active: { type: "boolean" },
                defaultPrice: { type: "string", from: "default_price", optional: true },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: [
          {
            id: "prod_1",
            name: "Pro plan",
            description: "Everything in Pro",
            active: true,
            default_price: "price_1",
          },
        ],
      },
      expect: {
        products: [
          {
            id: "prod_1",
            name: "Pro plan",
            description: "Everything in Pro",
            active: true,
            defaultPrice: "price_1",
          },
        ],
      },
    },

    {
      name: "listPrices",
      summary: "List prices, optionally for one product.",
      useCases: ["list prices", "how much does this product cost", "what are our plans priced at"],
      sideEffects: "read",
      input: {
        product: { type: "string", optional: true, describe: "Product id to filter by." },
        active: { type: "boolean", optional: true },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: {
        method: "GET",
        path: "prices",
        query: { product: "$product", active: "$active", limit: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          prices: {
            type: "array",
            from: "data",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                product: { type: "string" },
                unitAmount: { type: "number", from: "unit_amount", optional: true },
                currency: { type: "string" },
                interval: { type: "string", from: "recurring.interval", optional: true },
                active: { type: "boolean" },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: [
          {
            id: "price_1",
            product: "prod_1",
            unit_amount: 4900,
            currency: "usd",
            recurring: { interval: "month" },
            active: true,
          },
        ],
      },
      expect: {
        prices: [
          {
            id: "price_1",
            product: "prod_1",
            unitAmount: 4900,
            currency: "usd",
            interval: "month",
            active: true,
          },
        ],
      },
    },

    {
      name: "createPaymentLink",
      summary: "Create a shareable payment link for a price.",
      useCases: ["create a payment link", "send someone a link to pay", "take a payment by link"],
      sideEffects: "write",
      input: {
        priceId: { type: "string", describe: "Price id from stripe.listPrices." },
        quantity: { type: "int", min: 1, default: 1, optional: true },
      },
      request: {
        method: "POST",
        path: "payment_links",
        // Stripe encodes nested arrays in the form key itself.
        form: { "line_items[0][price]": "$priceId", "line_items[0][quantity]": "$quantity" },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          url: { type: "string" },
          active: { type: "boolean" },
        },
      },
      args: { priceId: "price_1" },
      sample: { id: "plink_1", url: "https://buy.stripe.com/test_1", active: true },
      expect: { id: "plink_1", url: "https://buy.stripe.com/test_1", active: true },
    },

    {
      name: "getCharge",
      summary: "Read one charge.",
      useCases: ["read a charge", "did this payment succeed", "charge details"],
      sideEffects: "read",
      input: { chargeId: { type: "string" } },
      request: { method: "GET", path: "charges/{chargeId}" },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string" },
          status: { type: "string" },
          paid: { type: "boolean" },
          refunded: { type: "boolean" },
          customer: { type: "string", optional: true },
          failureMessage: { type: "string", from: "failure_message", optional: true },
          receiptUrl: { type: "string", from: "receipt_url", optional: true },
        },
      },
      args: { chargeId: "ch_1" },
      sample: {
        id: "ch_1",
        amount: 4900,
        currency: "usd",
        status: "succeeded",
        paid: true,
        refunded: false,
        customer: "cus_1",
        receipt_url: "https://pay.stripe.com/receipts/ch_1",
      },
      expect: {
        id: "ch_1",
        amount: 4900,
        currency: "usd",
        status: "succeeded",
        paid: true,
        refunded: false,
        customer: "cus_1",
        receiptUrl: "https://pay.stripe.com/receipts/ch_1",
      },
    },

    {
      name: "searchCharges",
      summary: "Search charges with Stripe's query language.",
      useCases: ["search charges", "find payments over an amount", "search payments by metadata"],
      sideEffects: "read",
      input: {
        query: {
          type: "string",
          min: 1,
          describe: "Stripe search syntax, e.g. \"status:'failed' AND created>1764000000\".",
        },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: {
        method: "GET",
        path: "charges/search",
        query: { query: "$query", limit: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          charges: {
            type: "array",
            from: "data",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                amount: { type: "number" },
                currency: { type: "string" },
                status: { type: "string" },
                customer: { type: "string", optional: true },
                created: { type: "number" },
              },
            },
          },
        },
      },
      args: { query: "status:'failed'" },
      sample: {
        data: [
          {
            id: "ch_2",
            amount: 4900,
            currency: "usd",
            status: "failed",
            customer: "cus_1",
            created: 1764000000,
          },
        ],
      },
      expect: {
        charges: [
          {
            id: "ch_2",
            amount: 4900,
            currency: "usd",
            status: "failed",
            customer: "cus_1",
            created: 1764000000,
          },
        ],
      },
    },

    {
      name: "listRefunds",
      summary: "List refunds, optionally for one charge.",
      useCases: ["list refunds", "was this charge refunded", "recent refunds"],
      sideEffects: "read",
      input: {
        charge: { type: "string", optional: true },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: { method: "GET", path: "refunds", query: { charge: "$charge", limit: "$limit" } },
      output: {
        type: "object",
        fields: {
          refunds: {
            type: "array",
            from: "data",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                amount: { type: "number" },
                status: { type: "string", optional: true },
                charge: { type: "string", optional: true },
                reason: { type: "string", optional: true },
                created: { type: "number" },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: [
          {
            id: "re_1",
            amount: 4900,
            status: "succeeded",
            charge: "ch_1",
            reason: "requested_by_customer",
            created: 1764003600,
          },
        ],
      },
      expect: {
        refunds: [
          {
            id: "re_1",
            amount: 4900,
            status: "succeeded",
            charge: "ch_1",
            reason: "requested_by_customer",
            created: 1764003600,
          },
        ],
      },
    },

    {
      name: "listPayouts",
      summary: "List payouts to the bank account.",
      useCases: ["list payouts", "when is the next payout", "has stripe paid out yet"],
      sideEffects: "read",
      input: {
        status: { type: "string", optional: true, describe: 'e.g. "paid", "pending", "failed".' },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: { method: "GET", path: "payouts", query: { status: "$status", limit: "$limit" } },
      output: {
        type: "object",
        fields: {
          payouts: {
            type: "array",
            from: "data",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                amount: { type: "number" },
                currency: { type: "string" },
                status: { type: "string" },
                arrivalDate: { type: "number", from: "arrival_date" },
                created: { type: "number" },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: [
          {
            id: "po_1",
            amount: 120000,
            currency: "usd",
            status: "paid",
            arrival_date: 1764086400,
            created: 1764000000,
          },
        ],
      },
      expect: {
        payouts: [
          {
            id: "po_1",
            amount: 120000,
            currency: "usd",
            status: "paid",
            arrivalDate: 1764086400,
            created: 1764000000,
          },
        ],
      },
    },

    {
      name: "listDisputes",
      summary: "List disputes and chargebacks.",
      useCases: ["list disputes", "any chargebacks", "what is being disputed"],
      keywords: ["chargeback", "fraud"],
      sideEffects: "read",
      input: {
        charge: { type: "string", optional: true },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: { method: "GET", path: "disputes", query: { charge: "$charge", limit: "$limit" } },
      output: {
        type: "object",
        fields: {
          disputes: {
            type: "array",
            from: "data",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                amount: { type: "number" },
                currency: { type: "string" },
                reason: { type: "string" },
                status: { type: "string" },
                charge: { type: "string", optional: true },
                created: { type: "number" },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: [
          {
            id: "dp_1",
            amount: 4900,
            currency: "usd",
            reason: "fraudulent",
            status: "needs_response",
            charge: "ch_1",
            created: 1764003600,
          },
        ],
      },
      expect: {
        disputes: [
          {
            id: "dp_1",
            amount: 4900,
            currency: "usd",
            reason: "fraudulent",
            status: "needs_response",
            charge: "ch_1",
            created: 1764003600,
          },
        ],
      },
    },

    {
      name: "listBalanceTransactions",
      summary: "List balance transactions, with fees and net amounts.",
      useCases: [
        "what fees did stripe charge",
        "list balance transactions",
        "net revenue after fees",
      ],
      sideEffects: "read",
      input: {
        type: { type: "string", optional: true, describe: 'e.g. "charge", "refund", "payout".' },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: {
        method: "GET",
        path: "balance_transactions",
        query: { type: "$type", limit: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          transactions: {
            type: "array",
            from: "data",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                amount: { type: "number" },
                fee: { type: "number" },
                net: { type: "number" },
                currency: { type: "string" },
                type: { type: "string" },
                description: { type: "string", optional: true },
                created: { type: "number" },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: [
          {
            id: "txn_1",
            amount: 4900,
            fee: 172,
            net: 4728,
            currency: "usd",
            type: "charge",
            description: "Pro plan",
            created: 1764000000,
          },
        ],
      },
      expect: {
        transactions: [
          {
            id: "txn_1",
            amount: 4900,
            fee: 172,
            net: 4728,
            currency: "usd",
            type: "charge",
            description: "Pro plan",
            created: 1764000000,
          },
        ],
      },
    },

    {
      name: "listEvents",
      summary: "List recent account events, newest first.",
      useCases: [
        "what happened in stripe recently",
        "list stripe events",
        "recent account activity",
      ],
      sideEffects: "read",
      input: {
        type: { type: "string", optional: true, describe: 'e.g. "charge.failed" or "invoice.*".' },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: { method: "GET", path: "events", query: { type: "$type", limit: "$limit" } },
      output: {
        type: "object",
        fields: {
          events: {
            type: "array",
            from: "data",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                type: { type: "string" },
                created: { type: "number" },
                objectId: { type: "string", from: "data.object.id", optional: true },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: [
          {
            id: "evt_1",
            type: "charge.failed",
            created: 1764000000,
            data: { object: { id: "ch_2" } },
          },
        ],
      },
      expect: {
        events: [{ id: "evt_1", type: "charge.failed", created: 1764000000, objectId: "ch_2" }],
      },
    },
  ],
};
