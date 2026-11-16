"""Contract regressions; run from any directory with Python unittest."""
import copy
import unittest
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate

SPEC = yaml.safe_load(Path(__file__).with_name("openapi.yaml").read_text(encoding="utf-8"))
UUID = "12345678-1234-4234-8234-123456789abc"
NOW = "2026-10-19T10:00:00Z"


def admin_user():
    return {"id": UUID, "email": "staff@example.com", "displayName": "Staff", "locale": "en",
            "status": "active", "roleIds": [UUID], "mfaRequired": True, "mfaEnabled": True,
            "version": 1, "lastLoginAt": None, "createdAt": NOW, "updatedAt": NOW}


def errors(name, value):
    schema = {"$ref": f"#/components/schemas/{name}", "components": SPEC["components"]}
    return list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(value))


class ContractTests(unittest.TestCase):
    def test_invitation_management_preserves_credentials_and_version_boundaries(self):
        invitation = {"id": UUID, "userId": UUID, "status": "pending", "version": 1,
                      "expiresAt": NOW, "lastSentAt": NOW, "notificationJobId": None}
        self.assertEqual([], errors("AdminInvitationSummary", invitation))
        self.assertTrue(errors("AdminInvitationSummary", dict(invitation, invitationToken="secret")))
        for action in ("resend", "revoke"):
            operation = SPEC["paths"][f"/admin/users/{{id}}/invitation/{action}"]["post"]
            self.assertEqual("staff.manage", operation["x-permission"])
            self.assertEqual([{"AdminSession": [], "CsrfToken": []}], operation["security"])
            self.assertIn({"$ref": "#/components/parameters/IfMatch"}, operation["parameters"])
        resend = SPEC["paths"]["/admin/users/{id}/invitation/resend"]["post"]
        self.assertIn({"$ref": "#/components/parameters/IdempotencyKey"}, resend["parameters"])

    def test_market_review_requires_owner_mfa_and_server_assigned_reviewer(self):
        operation = SPEC["paths"]["/admin/store-config/markets/{marketCode}/reviews"]["post"]
        self.assertTrue(operation["x-owner-required"])
        self.assertTrue(operation["x-mfa-required"])
        self.assertEqual([{"AdminSession": [], "CsrfToken": []}], operation["security"])
        request = {"decision": "approved", "evidenceReference": "client-approved-review-1", "reason": "approved scope",
                   "validUntil": None, "confirmedMarketCode": "HK"}
        self.assertEqual([], errors("MarketReviewRequest", request))
        self.assertTrue(errors("MarketReviewRequest", dict(request, reviewedBy=UUID)))
        self.assertTrue(errors("MarketReviewRequest", dict(request, decision="expired")))

    def test_admin_login_challenges_are_discriminated(self):
        verify = {"challengeId": UUID, "nextAction": "verify_mfa", "allowedMethods": ["totp"], "expiresAt": NOW}
        setup = {"challengeId": UUID, "nextAction": "enroll_mfa", "expiresAt": NOW}
        for challenge in (verify, setup):
            payload = {"data": challenge, "meta": {"requestId": "req-test"}}
            self.assertEqual([], errors("AdminAuthenticationChallengeEnvelope", payload))
            self.assertTrue(errors("AdminSessionData", challenge))
        setup["allowedMethods"] = ["recovery_code"]
        self.assertTrue(errors("AdminMfaSetupChallenge", setup))

    def test_bootstrap_and_invitation_cannot_choose_privileges(self):
        owner = {"email": "owner@example.com", "displayName": "Owner", "password": "x" * 12, "locale": "en"}
        invitation = {"invitationToken": "x" * 32, "newPassword": "x" * 12}
        for schema, value in (("BootstrapOwnerRequest", owner), ("AcceptAdminInvitationRequest", invitation)):
            self.assertEqual([], errors(schema, value))
            for key in ("roleIds", "userId", "mfaRequired", "emailVerified"):
                invalid = dict(value, **{key: True})
                self.assertTrue(errors(schema, invalid))
        route = SPEC["paths"]["/admin/auth/bootstrap"]["post"]
        self.assertEqual([{"DeploymentBootstrap": []}], route["security"])
        self.assertEqual("header", SPEC["components"]["securitySchemes"]["DeploymentBootstrap"]["in"])

    def test_mfa_enrollment_uses_separate_capability(self):
        for path in ("/admin/auth/mfa/enrollments", "/admin/auth/mfa/enrollments/confirm"):
            operation = SPEC["paths"][path]["post"]
            self.assertEqual([{"AdminMfaSetup": []}], operation["security"])
            self.assertTrue(operation["x-origin-check"])
        authorize = SPEC["paths"]["/admin/auth/mfa/enrollment-authorizations"]["post"]
        self.assertEqual([{"AdminSession": [], "CsrfToken": []}], authorize["security"])
        confirm = {"challengeId": UUID, "enrollmentId": UUID, "code": "123456"}
        self.assertEqual([], errors("ConfirmMfaEnrollmentRequest", confirm))
        for change in ({"code": "recovery-code-1234"}, {"totpSecret": "UNTRUSTED"}, {"userId": UUID}):
            self.assertTrue(errors("ConfirmMfaEnrollmentRequest", dict(confirm, **change)))

    def test_pending_enrollment_does_not_grant_session(self):
        pending = {"enrollmentId": UUID, "expiresAt": NOW, "totpSecret": "JBSWY3DPEHPK3PXP",
                   "provisioningUri": "otpauth://totp/Store:staff?secret=JBSWY3DPEHPK3PXP"}
        self.assertEqual([], errors("AdminMfaEnrollment", pending))
        self.assertTrue(errors("AdminSessionData", pending))
        pending["session"] = {}
        self.assertTrue(errors("AdminMfaEnrollment", pending))

    def test_recovery_codes_only_appear_at_confirmed_enrollment(self):
        session = {"user": admin_user(), "permissionCodes": [], "mfaVerified": True,
                   "idleExpiresAt": NOW, "absoluteExpiresAt": NOW, "csrfToken": "x" * 32}
        confirmed = {"session": session, "recoveryCodes": [f"RECOVERY-CODE-{i:06d}" for i in range(10)]}
        self.assertEqual([], errors("AdminMfaEnrollmentConfirmed", confirmed))
        self.assertTrue(errors("AdminSessionData", dict(session, recoveryCodes=confirmed["recoveryCodes"])))
        confirmed["recoveryCodes"] *= 2
        self.assertTrue(errors("AdminMfaEnrollmentConfirmed", confirmed))

    def test_session_management_never_returns_authentication_token(self):
        view = {"id": UUID, "createdAt": NOW, "lastSeenAt": NOW, "idleExpiresAt": NOW,
                "absoluteExpiresAt": NOW, "current": True}
        self.assertEqual([], errors("AdminSessionView", view))
        for key in ("sessionToken", "cookie", "csrfToken", "passwordHash"):
            self.assertTrue(errors("AdminSessionView", dict(view, **{key: "forbidden"})))
        own = SPEC["paths"]["/admin/auth/sessions/{id}/revoke"]["post"]
        self.assertEqual([{"AdminSession": [], "CsrfToken": []}], own["security"])
        staff = SPEC["paths"]["/admin/users/{id}/sessions"]["get"]
        self.assertEqual("staff.read", staff["x-permission"])

    def test_r1_operations_have_specific_success_contracts(self):
        for path, item in SPEC["paths"].items():
            for method, operation in item.items():
                if not isinstance(operation, dict) or not set(operation.get("tags", [])) & {"AdminAuth", "AdminAccess", "StoreConfig"}:
                    continue
                for code, response in operation["responses"].items():
                    if code.startswith("2") and code != "204":
                        self.assertNotIn(response.get("$ref", "").rsplit("/", 1)[-1],
                                         {"Success", "Created", "Accepted"}, (method, path, code))

    def test_mfa_challenge_is_separate_from_admin_session(self):
        challenge = {"challengeId": UUID, "nextAction": "verify_mfa", "allowedMethods": ["totp", "recovery_code"], "expiresAt": NOW}
        self.assertEqual([], errors("AdminMfaChallenge", challenge))
        self.assertEqual([], errors("MfaVerifyRequest", {"challengeId": challenge["challengeId"], "code": "123456"}))
        self.assertTrue(errors("AdminSessionData", challenge))
        challenge["sessionToken"] = "forbidden"
        self.assertTrue(errors("AdminMfaChallenge", challenge))
        verify = SPEC["paths"]["/admin/auth/mfa/verify"]["post"]
        self.assertEqual([{"AdminLoginChallenge": []}], verify["security"])

    def test_mfa_required_user_cannot_have_unverified_session(self):
        session = {"user": admin_user(), "permissionCodes": ["staff.read"], "mfaVerified": True,
                   "idleExpiresAt": NOW, "absoluteExpiresAt": NOW, "csrfToken": "x" * 32}
        self.assertEqual([], errors("AdminSessionData", session))
        session["mfaVerified"] = False
        self.assertTrue(errors("AdminSessionData", session))
        session["mfaVerified"] = True
        session["user"]["mfaEnabled"] = False
        self.assertTrue(errors("AdminSessionData", session))
        session["user"]["mfaRequired"] = False
        session["mfaVerified"] = False
        self.assertEqual([], errors("AdminSessionData", session))
        for status in ("invited", "suspended"):
            session["user"]["status"] = status
            self.assertTrue(errors("AdminSessionData", session))

    def test_admin_user_and_role_lists_are_typed_and_paginated(self):
        role = {"id": UUID, "name": "Reader", "description": None, "permissionCodes": ["staff.read"],
                "version": 1, "createdAt": NOW, "updatedAt": NOW}
        for name, item in [("AdminUserListEnvelope", admin_user()), ("AdminRoleListEnvelope", role)]:
            payload = {"data": {"items": [item], "nextCursor": None, "hasMore": False}, "meta": {"requestId": "req-test"}}
            self.assertEqual([], errors(name, payload))
            payload["data"]["items"][0]["passwordHash"] = "forbidden"
            self.assertTrue(errors(name, payload))

    def test_market_approval_cannot_be_bypassed_in_config(self):
        market = {"marketCode": "HK", "enabled": False, "eligibleProductIds": [], "reviewStatus": "pending", "reviewValidUntil": None}
        self.assertEqual([], errors("MarketProfile", market))
        market["enabled"] = True
        self.assertTrue(errors("MarketProfile", market))
        market["reviewStatus"] = "approved"
        self.assertEqual([], errors("MarketProfile", market))
        self.assertTrue(errors("MarketProfileInput", market))
        config = {"displayName": "Store", "locales": ["zh-HK", "en"], "defaultLocale": "zh-HK",
                  "baseCurrency": "HKD", "timezone": "Asia/Hong_Kong", "marketProfiles": [market],
                  "featureFlags": {}, "brandAssets": {"logoMediaId": None, "faviconMediaId": None}, "version": 1, "updatedAt": NOW}
        self.assertEqual([], errors("StoreConfiguration", config))
        del config["version"]
        self.assertTrue(errors("StoreConfiguration", config))

    def test_editable_r1_resources_supply_etags(self):
        for resource in ("AdminUserSuccess", "AdminRoleSuccess", "StoreConfigurationSuccess"):
            self.assertIn("ETag", SPEC["components"]["responses"][resource]["headers"])
        for path in ("/admin/users/{id}", "/admin/roles/{id}", "/admin/store-config"):
            parameters = SPEC["paths"][path]["patch"]["parameters"]
            self.assertIn({"$ref": "#/components/parameters/IfMatch"}, parameters)

    def test_password_reset_response_has_no_identity_or_credentials(self):
        self.assertEqual([], errors("PasswordResetAccepted", {"requestAccepted": True}))
        for key in ("emailExists", "resetToken", "sessionToken"):
            self.assertTrue(errors("PasswordResetAccepted", {"requestAccepted": True, key: "forbidden"}))

    def test_openapi(self):
        validate(SPEC)

    def test_operation_ids_and_admin_permission_coverage(self):
        ids = []
        for path, item in SPEC["paths"].items():
            for method, operation in item.items():
                if method not in {"get", "post", "put", "patch", "delete", "head", "options"}:
                    continue
                ids.append(operation["operationId"])
                if path.startswith("/admin/") and not path.startswith("/admin/auth/"):
                    self.assertTrue(operation.get("x-permission"), (method, path))
        self.assertEqual(len(ids), len(set(ids)))

    def test_order_actions_use_separate_permissions_and_versioned_bodies(self):
        expected = {
            ("/admin/orders", "get"): "orders.read",
            ("/admin/orders/{id}", "get"): "orders.read",
            ("/admin/orders/{id}/cancel", "post"): "orders.cancel",
            ("/admin/orders/{id}/address-change", "post"): "orders.address_change",
            ("/admin/orders/{id}/notes", "post"): "orders.update",
            ("/admin/orders/{id}/shipments", "post"): "shipments.manage",
            ("/admin/shipments/{id}/dispatch", "post"): "shipments.manage",
            ("/admin/shipments/{id}/deliver", "post"): "shipments.manage",
        }
        for (path, method), permission in expected.items():
            operation = SPEC["paths"][path][method]
            self.assertEqual(permission, operation["x-permission"], path)
            # 读接口只认会话；写接口还必须带 CSRF，否则跨站请求可以借用户会话下单。
            security = [{"AdminSession": []}] if method == "get" else [{"AdminSession": [], "CsrfToken": []}]
            self.assertEqual(security, operation["security"], path)
        # 取消与改址必须带幂等键；发货必须带 If-Match，否则无法证明改的是哪一版。
        for path in ("/admin/orders/{id}/cancel", "/admin/orders/{id}/address-change"):
            self.assertIn({"$ref": "#/components/parameters/IdempotencyKey"},
                          SPEC["paths"][path]["post"]["parameters"])
        self.assertIn({"$ref": "#/components/parameters/IfMatch"},
                      SPEC["paths"]["/admin/shipments/{id}/dispatch"]["post"]["parameters"])
        # 字段级权限只影响遮蔽，不能成为读写门槛。
        self.assertEqual(["customers.read_pii"],
                         SPEC["paths"]["/admin/orders"]["get"]["x-field-permissions"])

    def test_admin_order_requires_version_and_rejects_unknown_actions(self):
        order = {"id": UUID, "publicOrderNumber": "EZ-20261116-ABC123", "orderStatus": "awaiting_confirmation",
                 "paymentStatus": "cod_due", "fulfillmentStatus": "unfulfilled", "currency": "HKD", "version": 1,
                 "totalMinor": 23000, "lines": [], "shipments": [], "statusHistory": [], "notes": [],
                 "createdAt": NOW, "updatedAt": NOW}
        self.assertEqual([], errors("AdminOrder", order))
        # 没有版本号的订单详情无法驱动取消/改址，属于契约缺口。
        without_version = copy.deepcopy(order)
        del without_version["version"]
        self.assertTrue(errors("AdminOrder", without_version))
        self.assertTrue(errors("AdminOrder", dict(order, orderStatus="refunded")))
        self.assertTrue(errors("AdminOrder", dict(order, paymentStatus="paid")))
        cancel = {"reason": "Customer request", "expectedVersion": 1, "customerNotified": False}
        self.assertEqual([], errors("OrderCancelRequest", cancel))
        self.assertTrue(errors("OrderCancelRequest", dict(cancel, totalMinor=0)))
        self.assertTrue(errors("OrderCancelRequest", {"reason": "x"}))
        address = {"expectedVersion": 1, "address": {"countryCode": "HK", "addressLine1": "1 Queen Road"}}
        self.assertEqual([], errors("OrderAddressChangeRequest", address))
        self.assertTrue(errors("OrderAddressChangeRequest", dict(address, expectedVersion=0)))
        shipment = {"items": [{"orderItemId": UUID, "quantity": 1}]}
        self.assertEqual([], errors("ShipmentCreateRequest", shipment))
        self.assertTrue(errors("ShipmentCreateRequest", {"items": []}))

    def test_quote_can_be_consumed_by_order_request(self):
        quote = {
            "quoteId": UUID, "version": 1, "expiresAt": "2026-10-19T10:00:00Z",
            "currency": "HKD", "subtotalMinor": 1000, "discountMinor": 0,
            "shippingMinor": 0, "taxMinor": 0, "totalMinor": 1000,
            "lines": [{"variantId": UUID, "sku": "SKU-1", "productName": "Item",
                       "quantity": 1, "unitPriceMinor": 1000, "lineSubtotalMinor": 1000,
                       "lineDiscountMinor": 0, "lineTotalMinor": 1000}],
            "shippingMethod": {"code": "standard", "name": "Standard"},
            "couponSummary": None, "ruleVersions": {"price": "1", "promotion": "1", "shipping": "1", "tax": None},
            "warnings": [],
        }
        self.assertEqual([], errors("CheckoutQuote", quote))
        self.assertEqual([], errors("CheckoutOrderRequest", {
            "quoteId": quote["quoteId"], "confirmedQuoteVersion": quote["version"], "paymentMethodCode": "cod"}))
        for key in ("version", "shippingMethod", "couponSummary", "warnings", "ruleVersions"):
            invalid = copy.deepcopy(quote)
            del invalid[key]
            self.assertTrue(errors("CheckoutQuote", invalid), key)
        quote["totalMinor"] = 1.5
        self.assertTrue(errors("CheckoutQuote", quote))

    def test_cart_response_is_typed_and_never_carries_client_prices(self):
        line = {"id": UUID, "variantId": UUID, "sku": "SKU-1", "productName": "Item", "variantName": None,
                "quantity": 2, "unitPriceMinor": 1000, "lineSubtotalMinor": 2000,
                "available": True, "availableQuantity": 5}
        self.assertEqual([], errors("CartLine", line))
        for key in ("priceMinor", "reserved", "onHand", "costMinor"):
            self.assertTrue(errors("CartLine", dict(line, **{key: 1})), key)
        cart = {"cartId": UUID, "currency": "HKD", "locale": "en", "itemCount": 2, "subtotalMinor": 2000,
                "items": [line], "warnings": [], "expiresAt": NOW}
        self.assertEqual([], errors("Cart", cart))
        for key in ("cartId", "items", "subtotalMinor", "expiresAt"):
            invalid = copy.deepcopy(cart)
            del invalid[key]
            self.assertTrue(errors("Cart", invalid), key)
        # 购物车响应必须类型化，不能退回通用 Success：否则客户端无法知道行结构。
        for path, method in (("/storefront/cart", "get"), ("/storefront/cart/items", "post"),
                             ("/storefront/cart/items/{id}", "patch")):
            self.assertIn("CartSuccess", SPEC["paths"][path][method]["responses"]["200"]["$ref"])
        created = SPEC["paths"]["/storefront/cart"]["post"]["responses"]["201"]["$ref"]
        self.assertIn("CartCreatedSuccess", created)
        self.assertIn("Set-Cookie", SPEC["components"]["responses"]["CartCreatedSuccess"]["headers"])

    def test_response_variant_accepts_inventory_but_input_rejects_it(self):
        variant = {"sku": "SKU-1", "optionValues": {"size": "M"}, "priceMinor": 1000, "currency": "HKD"}
        self.assertEqual([], errors("ProductVariantInput", variant))
        response = dict(variant, id=UUID, onHand=5, reserved=1, available=4)
        self.assertEqual([], errors("ProductVariantResponse", response))
        self.assertTrue(errors("ProductVariantInput", response))
        response["unexpected"] = True
        self.assertTrue(errors("ProductVariantResponse", response))

    def test_contact_requires_nonempty_channel(self):
        for value in ({}, {"email": None}, {"phone": None}, {"phone": ""}, {"phone": "   "}, {"email": None, "phone": None}):
            self.assertTrue(errors("ContactInput", value), value)
        for value in ({"email": "buyer@example.com"}, {"phone": "+85212345678"}, {"email": None, "phone": "+85212345678"}):
            self.assertEqual([], errors("ContactInput", value), value)

    def test_otp_response_supplies_verification_challenge(self):
        response_ref = SPEC["paths"]["/storefront/member/otp/request"]["post"]["responses"]["202"]["$ref"]
        response = SPEC["components"]["responses"][response_ref.rsplit("/", 1)[1]]
        name = response["content"]["application/json"]["schema"]["$ref"].rsplit("/", 1)[1]
        payload = {"data": {"challengeId": UUID, "challengeAccepted": True, "resendAfterSeconds": 60, "expiresInSeconds": 300}, "meta": {"requestId": "req-test"}}
        self.assertEqual([], errors(name, payload))
        self.assertEqual([], errors("OtpVerifyRequest", {"challengeId": payload["data"]["challengeId"], "code": "123456"}))
        del payload["data"]["challengeId"]
        self.assertTrue(errors(name, payload))

    def test_payment_recording_is_a_versioned_idempotent_write(self):
        operation = SPEC["paths"]["/admin/orders/{id}/payment-result"]["post"]
        self.assertEqual("payments.collect", operation["x-permission"])
        self.assertEqual([{"AdminSession": [], "CsrfToken": []}], operation["security"])
        for ref in ("#/components/parameters/IdempotencyKey", "#/components/parameters/IfMatch"):
            self.assertIn({"$ref": ref}, operation["parameters"])
        body = {"outcome": "collected", "amountMinor": 23000, "occurredAt": NOW, "expectedVersion": 2}
        self.assertEqual([], errors("OrderPaymentResultRequest", body))
        # 金额是必填整数：客户端不能用“不传金额”让服务端自己猜收了多少。
        for key in ("outcome", "amountMinor", "occurredAt", "expectedVersion"):
            invalid = copy.deepcopy(body)
            del invalid[key]
            self.assertTrue(errors("OrderPaymentResultRequest", invalid), key)
        self.assertTrue(errors("OrderPaymentResultRequest", dict(body, outcome="refunded")))
        self.assertTrue(errors("OrderPaymentResultRequest", dict(body, amountMinor=0)))

    def test_payment_ledger_status_is_the_contract_closed_set(self):
        self.assertEqual(["pending", "authorized", "succeeded", "failed", "cancelled", "unknown",
                          "collected", "rejected", "returned"], SPEC["components"]["schemas"]["PaymentStatus"]["enum"])
        payment = {"id": UUID, "publicPaymentNumber": "PAY-20261116-AB12CD", "orderId": UUID,
                   "publicOrderNumber": "EZ-20261116-ABC123", "providerCode": "cod", "environment": "production",
                   "channel": "cod", "status": "collected", "amountMinor": 23000, "currency": "HKD", "version": 2,
                   "createdAt": NOW, "updatedAt": NOW, "paidAt": NOW}
        self.assertEqual([], errors("AdminPayment", payment))
        self.assertTrue(errors("AdminPayment", dict(payment, status="paid")))
        self.assertTrue(errors("AdminPayment", dict(payment, channel="card")))
        self.assertTrue(errors("AdminPayment", dict(payment, publicPaymentNumber="PAY-1")))
        # 台账不允许夹带未声明的字段（例如把渠道原始报文原样塞回来）。
        self.assertTrue(errors("AdminPayment", dict(payment, rawProviderPayload={"card": "4242"})))

    def test_payment_method_configuration_never_returns_credentials(self):
        method = {"id": UUID, "providerCode": "cod", "environment": "production", "displayName": "Cash on delivery",
                  "enabled": True, "approvalStatus": "approved", "publicConfig": {"instructions": "Pay on delivery"},
                  "secretConfigured": False, "connectionStatus": "unverified", "version": 1,
                  "createdAt": NOW, "updatedAt": NOW}
        self.assertEqual([], errors("AdminPaymentMethod", method))
        # 响应模型里没有 secretRef 这个字段：凭证引用一旦写进去，就再也不会被读出来。
        self.assertTrue(errors("AdminPaymentMethod", dict(method, secretRef="secret://prod/gateway")))
        self.assertTrue(errors("AdminPaymentMethod", dict(method, approvalStatus="pending")))
        request = {"providerCode": "manual_bank_transfer", "environment": "production", "enabled": True,
                   "approvalReference": "ticket-1", "secretRef": "secret://prod/bank"}
        self.assertEqual([], errors("PaymentMethodPatchRequest", request))
        self.assertTrue(errors("PaymentMethodPatchRequest", dict(request, environment="staging")))
        self.assertTrue(errors("PaymentMethodPatchRequest", dict(request, enabled="yes")))
        patch = SPEC["paths"]["/admin/payment-methods"]["patch"]
        self.assertEqual("payment.config", patch["x-permission"])
        self.assertIn({"$ref": "#/components/parameters/IfMatch"}, patch["parameters"])


if __name__ == "__main__":
    unittest.main()
