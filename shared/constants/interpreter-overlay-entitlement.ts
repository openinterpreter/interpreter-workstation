export const INTERPRETER_OVERLAY_ALLOWED_PRODUCT_IDS = [
  'prod_R6DVWtAxxJZHHW',
  'prod_S4sRmZz6s5P6oG',
  'prod_SG0h5xCHKMN1Be',
  'prod_SgzEMtPNdTb6Xt',
  'prod_SgzFt3dadtnt7g',
] as const;

export function isInterpreterOverlayAllowedProductId(
  productId: string | null | undefined,
): boolean {
  return !!productId
    && INTERPRETER_OVERLAY_ALLOWED_PRODUCT_IDS.includes(
      productId as (typeof INTERPRETER_OVERLAY_ALLOWED_PRODUCT_IDS)[number],
    );
}
