import { describe, expect, it } from 'vitest';
import { OrderPayloadError, parseOrder, toStandardProduct } from '../src/index';
import { orderPayload } from './helpers';

describe('toStandardProduct', () => {
  it('builds the standard format, variants and options included', () => {
    const product = toStandardProduct(
      {
        id: 1001,
        title: 'Hero Hoodie',
        price: 1500,
        salePrice: '1,200',
        categories: ['Hoodies', null, 'Hoodies', 'Winter'],
        images: ['https://cdn.test/a.jpg', ''],
        variants: [
          { id: 'M', price: 1500, stockQuantity: 7, options: { Size: 'M', Color: 'Red' } },
          { id: 'L', title: 'Large', price: '1500', inStock: false, options: { Size: 'L', Color: 'Red' } },
        ],
        updatedAt: new Date('2026-10-01T10:00:00Z'),
      },
      'BDT',
    );
    expect(product).toMatchObject({
      id: '1001',
      status: 'active',
      price: '1500.00',
      sale_price: '1200.00',
      currency: 'BDT',
      categories: ['Hoodies', 'Winter'],
      images: ['https://cdn.test/a.jpg'],
      in_stock: null,
      options: [
        { name: 'Size', values: ['M', 'L'] },
        { name: 'Color', values: ['Red'] },
      ],
      updated_at: '2026-10-01T10:00:00.000Z',
    });
    expect(product.variants[0]).toMatchObject({ id: 'M', title: 'M / Red', in_stock: true, stock_quantity: 7 });
    expect(product.variants[1]).toMatchObject({ title: 'Large', in_stock: false, stock_quantity: null });
  });

  it('derives in-stock from the quantity', () => {
    expect(toStandardProduct({ id: 1, title: 'A', stockQuantity: 0, status: 'draft' })).toMatchObject({
      in_stock: false,
      status: 'draft',
      price: null,
    });
  });
});

describe('parseOrder', () => {
  it('reads the order OmniConva sends', () => {
    const order = parseOrder(orderPayload());
    expect(order).toMatchObject({
      id: '6a3f0c1e-2b7d-4c1a-9f3e-8d2b1c0a9e77',
      number: '1042',
      test: false,
      customer: { name: 'Rahim Uddin', phone: '01711000000' },
      shippingAddress: { city: 'Dhaka', country: 'BD' },
      shipping: { title: 'Inside Dhaka', amount: '60.00' },
      total: '1240.00',
      payment: { method: 'cash_on_delivery', status: 'unpaid' },
    });
    expect(order.items[0]).toMatchObject({ productId: '1', variantId: '1', quantity: 2, unitPrice: '590.00' });
  });

  it.each([[{ items: [{ product_id: 1 }] }], [{ id: 'x', items: [] }], [{ id: 'x', items: [{ title: 'no id' }] }], ['nope']])(
    'refuses %j',
    (payload) => {
      expect(() => parseOrder(payload)).toThrow(OrderPayloadError);
    },
  );
});
