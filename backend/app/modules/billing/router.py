"""
modules/billing/router.py
-------------------------
Central billing router — aggregates all domain sub-routers.
All billing endpoints require an active subscription with the 'billing' product enabled.
"""

from fastapi import APIRouter, Depends
from app.core.dependencies import require_active_subscription

from app.modules.billing.routers.settings_router import router as settings_router
from app.modules.billing.routers.customer_router import router as customer_router
from app.modules.billing.routers.product_router import router as product_router
from app.modules.billing.routers.pricing_router import router as pricing_router
from app.modules.billing.routers.price_list_router import router as price_list_router
from app.modules.billing.routers.pricing_rule_router import router as pricing_rule_router
from app.modules.billing.routers.discount_router import router as discount_router
from app.modules.billing.routers.currency_pricing_router import router as currency_pricing_router
from app.modules.billing.routers.tax_pricing_router import router as tax_pricing_router
from app.modules.billing.routers.contract_router import router as contract_router
from app.modules.billing.routers.quote_router import router as quote_router
from app.modules.billing.routers.subscription_router import router as subscription_router
from app.modules.billing.routers.invoice_router import router as invoice_router
from app.modules.billing.routers.payment_router import router as payment_router
from app.modules.billing.routers.stripe_router import router as stripe_router
from app.modules.billing.routers.stripe_connect_router import router as stripe_connect_router
from app.modules.billing.routers.credit_note_router import router as credit_note_router
from app.modules.billing.routers.refund_router import router as refund_router
from app.modules.billing.routers.write_off_router import router as write_off_router
from app.modules.billing.routers.tax_router import router as tax_router
from app.modules.billing.routers.dunning_router import router as dunning_router
from app.modules.billing.routers.collection_router import router as collection_router
from app.modules.billing.routers.promise_to_pay_router import router as promise_to_pay_router
from app.modules.billing.routers.revenue_router import router as revenue_router
from app.modules.billing.routers.audit_router import router as audit_router
from app.modules.billing.routers.dashboard_router import router as dashboard_router

billing_router = APIRouter(
    prefix="/billing",
    tags=["Billing Module"],
    dependencies=[Depends(require_active_subscription("billing"))],
)

billing_router.include_router(settings_router)
billing_router.include_router(customer_router)
billing_router.include_router(product_router)
billing_router.include_router(pricing_router)
billing_router.include_router(price_list_router)
billing_router.include_router(pricing_rule_router)
billing_router.include_router(discount_router)
billing_router.include_router(currency_pricing_router)
billing_router.include_router(tax_pricing_router)
billing_router.include_router(contract_router)
billing_router.include_router(quote_router)
billing_router.include_router(subscription_router)
billing_router.include_router(invoice_router)
billing_router.include_router(payment_router)
billing_router.include_router(stripe_router)
billing_router.include_router(stripe_connect_router)
billing_router.include_router(credit_note_router)
billing_router.include_router(refund_router)
billing_router.include_router(write_off_router)
billing_router.include_router(tax_router)
billing_router.include_router(dunning_router)
billing_router.include_router(collection_router)
billing_router.include_router(promise_to_pay_router)
billing_router.include_router(revenue_router)
billing_router.include_router(audit_router)
billing_router.include_router(dashboard_router)
