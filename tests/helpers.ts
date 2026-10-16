import { createOmniConva, signRequest, OrderRefusedError, type OmniConvaOptions, type ProductInput } from '../src/index';

export const SECRET = 'test-secret';
export const TOKEN = 'test-token';
export const WEBHOOK_URL = 'https://api.omniconva.test/webhooks/custom-website/store-1';

export const catalog: ProductInput[] = [
  {
    id: 1,
    title: 'Classic Tee',
    price: 650,
    salePrice: '590',
    images: ['https://cdn.shop.test/tee.jpg'],
    variants: [
      { id: 1, price: 650, stockQuantity: 12, options: { Size: 'S' } },
      { id: 2, price: 650, stockQuantity: 0, options: { Size: 'M' } },
    ],
  },
  { id: 2, title: 'Mug 1', price: 310, stockQuantity: 6 },
  { id: 3, title: 'Mug 2', price: 320, stockQuantity: 7 },
];

export function makeClient(overrides: OmniConvaOptions = {}) {
  const created: unknown[] = [];
  const client = createOmniConva({
    webhookUrl: WEBHOOK_URL,
    webhookToken: TOKEN,
    signingSecret: SECRET,
    currency: 'BDT',
    webhookRetryDelaysMs: [0, 0],
    products: {
      list: ({ page, perPage }) => ({
        products: catalog.slice((page - 1) * perPage, page * perPage),
        total: catalog.length,
      }),
      get: (id) => catalog.find((product) => String(product.id) === id) ?? null,
    },
    orders: {
      create(order) {
        if (order.customer.name === 'Refuse Me') throw new OrderRefusedError('Out of delivery area');
        if (order.customer.name === 'Break Me') throw new Error('insert into orders (phone) values ("017") — connection refused 10.0.0.5:5432');
        created.push(order);
        return { orderId: `W-${1000 + created.length}`, orderNumber: 5000 + created.length };
      },
    },
    ...overrides,
  });
  return { client, created };
}

export function signedRequest(path: string, init: { method?: string; body?: string; headers?: Record<string, string>; secret?: string } = {}) {
  const method = init.method ?? 'GET';
  const body = init.body ?? '';
  return new Request(`http://shop.test${path}`, {
    method,
    body: method === 'GET' ? undefined : body,
    headers: {
      'content-type': 'application/json',
      'x-omniconva-signature': signRequest(init.secret ?? SECRET, method, path, body),
      ...init.headers,
    },
  });
}

export const orderPayload = (overrides: Record<string, unknown> = {}) => ({
  id: '6a3f0c1e-2b7d-4c1a-9f3e-8d2b1c0a9e77',
  order_number: '1042',
  source: 'omniconva',
  currency: 'BDT',
  customer: { name: 'Rahim Uddin', phone: '01711000000' },
  shipping_address: { address: 'House 12, Road 4, Dhanmondi', city: 'Dhaka', state: null, postcode: null, country: 'BD' },
  items: [
    { product_id: '1', variant_id: '1', sku: 'TEE-S', title: 'Classic Tee – S', quantity: 2, unit_price: '590.00', total: '1180.00', image: null },
  ],
  subtotal: '1180.00',
  discount: '0.00',
  shipping: { title: 'Inside Dhaka', amount: '60.00' },
  fees: [],
  total: '1240.00',
  payment: { method: 'cash_on_delivery', status: 'unpaid' },
  note: 'Placed through OmniConva chat, cash on delivery.',
  ...overrides,
});
