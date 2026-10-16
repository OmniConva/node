import type { Money, Order, OrderItem, ProductInput, VariantInput } from './types';

/** Prices travel as decimal strings ("1500.00"). */
export function money(value: Money | unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const amount =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/,/g, '')) : NaN;
  return Number.isFinite(amount) ? amount.toFixed(2) : null;
}

function strings(values: (string | null | undefined)[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    if (value !== null && value !== undefined && String(value).trim() !== '' && !out.includes(String(value))) {
      out.push(String(value));
    }
  }
  return out;
}

function inStock(explicit: boolean | null | undefined, quantity: number | null | undefined): boolean | null {
  if (explicit !== undefined && explicit !== null) return explicit;
  return quantity === null || quantity === undefined ? null : quantity > 0;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function variantToStandard(variant: VariantInput) {
  const options = Object.fromEntries(
    Object.entries(variant.options ?? {}).map(([name, value]) => [name, String(value)]),
  );
  return {
    id: String(variant.id),
    title: variant.title ?? (Object.keys(options).length ? Object.values(options).join(' / ') : null),
    sku: variant.sku ?? null,
    price: money(variant.price),
    sale_price: money(variant.salePrice),
    in_stock: inStock(variant.inStock, variant.stockQuantity),
    stock_quantity: variant.stockQuantity ?? null,
    image: variant.image ?? null,
    options,
  };
}

/** A product in OmniConva's standard format (the Custom Website API v1). */
export function toStandardProduct(product: ProductInput, defaultCurrency: string | null = null) {
  const variants = (product.variants ?? []).map(variantToStandard);
  const options = new Map<string, string[]>();
  for (const variant of variants) {
    for (const [name, value] of Object.entries(variant.options)) {
      const values = options.get(name) ?? [];
      if (!values.includes(value)) values.push(value);
      options.set(name, values);
    }
  }
  return {
    id: String(product.id),
    title: product.title,
    url: product.url ?? null,
    description: product.description ?? null,
    short_description: product.shortDescription ?? null,
    status: product.status ?? 'active',
    sku: product.sku ?? null,
    brand: product.brand ?? null,
    categories: strings(product.categories),
    tags: strings(product.tags),
    images: strings(product.images),
    currency: product.currency ?? defaultCurrency,
    price: money(product.price),
    sale_price: money(product.salePrice),
    in_stock: inStock(product.inStock, product.stockQuantity),
    stock_quantity: product.stockQuantity ?? null,
    options: [...options].map(([name, values]) => ({ name, values })),
    variants,
    updated_at: iso(product.updatedAt),
  };
}

export class OrderPayloadError extends Error {}

function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Reads the order OmniConva POSTs to your Order API (standard format). */
export function parseOrder(payload: unknown): Order {
  const raw = record(payload);
  const id = text(raw.id);
  if (!id) throw new OrderPayloadError('The order has no id');
  const items: OrderItem[] = [];
  for (const entry of Array.isArray(raw.items) ? raw.items : []) {
    const item = record(entry);
    const productId = text(item.product_id);
    if (!productId) continue;
    const quantity = Math.max(1, Math.trunc(Number(item.quantity) || 1));
    const unitPrice = money(item.unit_price as Money) ?? '0.00';
    items.push({
      productId,
      variantId: text(item.variant_id),
      sku: text(item.sku),
      title: text(item.title) ?? '',
      quantity,
      unitPrice,
      total: money(item.total as Money) ?? (Number(unitPrice) * quantity).toFixed(2),
      image: text(item.image),
    });
  }
  if (!items.length) throw new OrderPayloadError('The order has no items');

  const customer = record(raw.customer);
  const address = record(raw.shipping_address);
  const shipping = raw.shipping ? record(raw.shipping) : null;
  const payment = record(raw.payment);
  return {
    id,
    number: text(raw.order_number),
    test: raw.test === true,
    currency: text(raw.currency),
    customer: { name: text(customer.name) ?? '', phone: text(customer.phone) ?? '' },
    shippingAddress: {
      address: text(address.address) ?? '',
      city: text(address.city),
      state: text(address.state),
      postcode: text(address.postcode),
      country: text(address.country),
    },
    items,
    subtotal: money(raw.subtotal as Money) ?? '0.00',
    discount: money(raw.discount as Money) ?? '0.00',
    shipping: shipping
      ? { title: text(shipping.title) ?? 'Delivery', amount: money(shipping.amount as Money) ?? '0.00' }
      : null,
    fees: (Array.isArray(raw.fees) ? raw.fees : []).map((fee) => {
      const f = record(fee);
      return { name: text(f.name) ?? 'Fee', amount: money(f.amount as Money) ?? '0.00' };
    }),
    total: money(raw.total as Money) ?? '0.00',
    payment: {
      method: text(payment.method) ?? 'cash_on_delivery',
      status: text(payment.status) ?? 'unpaid',
    },
    note: text(raw.note),
    raw,
  };
}
