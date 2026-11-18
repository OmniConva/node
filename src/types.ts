// What you give the package: your products, as OmniConva should sell them.

export type Money = number | string | null | undefined;

export interface VariantInput {
  /** Unique within its product, and stable: orders name the variant by it. */
  id: string | number;
  title?: string | null;
  sku?: string | null;
  /** The original price. */
  price?: Money;
  /**
   * What the customer pays now — a sale, or a campaign or coupon your shop
   * applies automatically. Only counts when below the price. Each variant
   * needs its own: a product's salePrice does not apply to its variants.
   */
  salePrice?: Money;
  /**
   * For shops whose `price` is already the price customers pay and the
   * original is kept as a "compare at" / "was" price (Shopify-style). When it
   * is above `price`, it is sent as the original and `price` as the sale.
   */
  compareAtPrice?: Money;
  inStock?: boolean | null;
  /** Null when you don't count stock; `inStock` then says in or out. */
  stockQuantity?: number | null;
  image?: string | null;
  /** e.g. `{ Size: 'M', Color: 'Red' }` */
  options?: Record<string, string | number>;
}

export interface ProductInput {
  /** Stable forever. */
  id: string | number;
  title: string;
  url?: string | null;
  description?: string | null;
  shortDescription?: string | null;
  /** 'active' (default) is for sale; 'draft', 'archived' or anything else is not. */
  status?: string;
  sku?: string | null;
  brand?: string | null;
  categories?: (string | null | undefined)[];
  tags?: (string | null | undefined)[];
  /** Absolute http(s) URLs. */
  images?: (string | null | undefined)[];
  currency?: string | null;
  /** The original price. */
  price?: Money;
  /**
   * What the customer pays now, when lower: a sale, or a campaign or coupon
   * your shop applies automatically (a "10% off" campaign is a salePrice of
   * 90% of the price). Give variants their own.
   */
  salePrice?: Money;
  /** See VariantInput.compareAtPrice. */
  compareAtPrice?: Money;
  inStock?: boolean | null;
  stockQuantity?: number | null;
  variants?: VariantInput[];
  updatedAt?: Date | string | null;
}

export interface ProductListQuery {
  /** Starts at 1. */
  page: number;
  /** 1–100. */
  perPage: number;
  /** Only what changed after this, when set. */
  since: Date | null;
}

export interface ProductListResult {
  products: ProductInput[];
  /** Total matching products; enables paging without `hasMore`. */
  total?: number | null;
  /** Whether another page follows; worked out from `total` when omitted. */
  hasMore?: boolean;
}

export interface ProductSource {
  /** One page of your catalog, in a stable order (e.g. by id). */
  list(query: ProductListQuery): Promise<ProductListResult> | ProductListResult;
  /** One product by id, or null when it doesn't exist (or isn't shared). */
  get(id: string): Promise<ProductInput | null> | ProductInput | null;
}

// What OmniConva sends: an order the customer confirmed in chat.

export interface OrderItem {
  /** Your product id. For a variant, its product's id. */
  productId: string;
  /** Your variant id, or null for a product without variants. */
  variantId: string | null;
  sku: string | null;
  title: string;
  quantity: number;
  /** Decimal string, e.g. "1200.00". */
  unitPrice: string;
  total: string;
  image: string | null;
}

export interface Order {
  /** OmniConva's id for the order (also the Idempotency-Key). */
  id: string;
  /** The number the customer was told, e.g. "1042". */
  number: string | null;
  /** A test order from the OmniConva dashboard. */
  test: boolean;
  currency: string | null;
  customer: { name: string; phone: string };
  shippingAddress: {
    address: string;
    city: string | null;
    state: string | null;
    postcode: string | null;
    /** ISO 3166-1 alpha-2, e.g. "BD". */
    country: string | null;
  };
  items: OrderItem[];
  subtotal: string;
  discount: string;
  shipping: { title: string; amount: string } | null;
  fees: { name: string; amount: string }[];
  total: string;
  payment: { method: string; status: string };
  note: string | null;
  /** The payload as received. */
  raw: Record<string, unknown>;
}

export interface OrderResult {
  /**
   * Your reference for the order: told to the customer in chat, and what
   * orderUpdated() names. Your id or your order number.
   */
  orderId: string | number;
  orderNumber?: string | number | null;
}

export interface OrderHandler {
  /**
   * Creates the order in your store. Called once per order: a retry with the
   * same Idempotency-Key is answered with the first result. Throw an
   * OrderRefusedError to refuse it: that message is shown to the store owner
   * in OmniConva. Any other error is reported to OmniConva as a generic
   * failure and passed to `onError` for your own logs.
   */
  create(order: Order): Promise<OrderResult> | OrderResult;
}

export interface Tracking {
  number?: string | null;
  carrier?: string | null;
  url?: string | null;
}
