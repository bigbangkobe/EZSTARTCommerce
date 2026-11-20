"""Contract regressions; run from any directory with Python unittest."""
import copy
import re
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

    def test_privacy_disposition_is_permissioned_and_typed(self):
        export = SPEC["paths"]["/admin/privacy-requests/{id}/export"]["post"]
        download = SPEC["paths"]["/admin/privacy-requests/{id}/export/{jobId}"]["get"]
        self.assertEqual("privacy.process", export["x-permission"])
        self.assertEqual("privacy.process", download["x-permission"])
        self.assertEqual([{"AdminSession": [], "CsrfToken": []}], export["security"])
        self.assertEqual([{"AdminSession": []}], download["security"])
        self.assertIn({"$ref": "#/components/parameters/IdempotencyKey"}, export["parameters"])
        job = {"id": UUID, "requestId": UUID, "customerId": UUID, "status": "ready", "byteSize": 128,
               "sha256": "a" * 64, "createdAt": NOW, "expiresAt": NOW, "revokedAt": None}
        self.assertEqual([], errors("PrivacyExportJob", job))
        self.assertTrue(errors("PrivacyExportJob", dict(job, status="pending")))
        self.assertTrue(errors("PrivacyExportJob", dict(job, sha256="not-a-hash")))
        artifact = {"schemaVersion": "privacy-disposition-v1", "requestNumber": "PR-20261117-0001",
                    "generatedAt": NOW,
                    "customer": {"id": UUID, "displayName": "Chan", "email": None, "phone": None, "tags": [],
                                 "status": "active", "internalNote": None, "createdAt": NOW, "updatedAt": NOW},
                    "member": None, "loyalty": {"account": None, "ledger": []}, "orders": [], "consents": []}
        self.assertEqual([], errors("PrivacyExportArtifact", artifact))
        self.assertTrue(errors("PrivacyExportArtifact", dict(artifact, member={"memberNo": "M-1"})))
        consent = {"channel": "email", "purpose": "marketing", "status": "withdrawn", "source": "privacy-request",
                   "evidenceRef": None, "updatedAt": NOW}
        self.assertEqual([], errors("PrivacyExportArtifact", dict(artifact, consents=[consent])))
        self.assertTrue(errors("PrivacyExportArtifact", dict(artifact, consents=[dict(consent, channel="carrier_pigeon")])))

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
            "pointsRequested": 0, "pointsRedeemed": 0, "pointsValueMinor": 0, "pointsRuleVersion": None,
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
        quote["totalMinor"] = 1000

        # 积分抵扣只减商品金额，不减运费；下单回执必须把扣了多少点/多少钱说清楚。
        request_schema = SPEC["components"]["schemas"]["CheckoutQuoteRequest"]
        self.assertIn("pointsToUse", request_schema["properties"])
        redeemed = copy.deepcopy(quote)
        redeemed.update({"pointsRequested": 12, "pointsRedeemed": 10, "pointsValueMinor": 300,
                         "pointsRuleVersion": "loyalty-redeem-v1", "shippingMinor": 50, "totalMinor": 750})
        self.assertEqual([], errors("CheckoutQuote", redeemed))
        self.assertTrue(errors("CheckoutQuote", dict(redeemed, pointsValueMinor=-1)))
        self.assertTrue(errors("CheckoutQuote", dict(redeemed, pointsRuleVersion=42)))
        created = {"orderId": UUID, "publicOrderNumber": "EZ-20261117-ABC123",
                   "orderStatus": "awaiting_confirmation", "paymentStatus": "cod_due",
                   "currency": "HKD", "totalMinor": 750, "pointsRedeemed": 10, "pointsValueMinor": 300,
                   "paymentAction": {"type": "none", "redirectUrl": None, "instructions": None}}
        self.assertEqual([], errors("CheckoutOrderCreated", created))
        self.assertTrue(errors("CheckoutOrderCreated", dict(created, pointsRedeemed="10")))

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

    def test_after_sales_case_schema_keeps_snapshots_and_closed_sets(self):
        self.assertEqual(["submitted", "under_review", "approved", "rejected", "needs_information",
                          "return_in_transit", "received_inspection", "refund_pending", "refunded",
                          "replacement_sent", "completed", "closed"],
                         SPEC["components"]["schemas"]["AfterSalesCaseStatus"]["enum"])
        self.assertEqual(["cancel", "refund", "return", "exchange"],
                         SPEC["components"]["schemas"]["AfterSalesCaseType"]["enum"])
        case = {
            "id": UUID, "publicCaseNumber": "AS-20261116-AB12CD", "orderId": UUID,
            "publicOrderNumber": "EZ-20261116-ABC123", "caseType": "return", "status": "received_inspection",
            "reason": "Wrong size", "source": "admin", "requestedRefundMinor": 20000,
            "approvedRefundMinor": 20000, "refundedMinor": 10000, "pendingRefundMinor": 0,
            "refundableMinor": 13000, "currency": "HKD", "orderStatus": "completed", "paymentStatus": "collected",
            "orderTotalMinor": 23000, "version": 3, "createdAt": NOW, "updatedAt": NOW,
            "items": [{"orderItemId": UUID, "sku": "SKU-1", "productName": "Test Product", "orderedQuantity": 2,
                       "requestedQuantity": 2, "receivedQuantity": 2, "inspectedQuantity": 1}],
            "refunds": [], "returns": [], "receipts": [], "inspections": [], "events": [],
        }
        self.assertEqual([], errors("AdminAfterSalesCase", case))
        # 案件响应里不能夹带订单快照之外的字段（例如直接改写后的订单金额）。
        self.assertTrue(errors("AdminAfterSalesCase", dict(case, rewrittenTotalMinor=1)))
        self.assertTrue(errors("AdminAfterSalesCase", dict(case, caseType="chargeback")))
        self.assertTrue(errors("AdminAfterSalesCase", dict(case, status="refund_pending_by_customer")))
        self.assertTrue(errors("AdminAfterSalesCase", dict(case, publicCaseNumber="AS-1")))

    def test_refund_ledger_is_a_separate_record_from_the_payment(self):
        self.assertEqual(["requested", "approved", "processing", "refunded", "failed", "rejected", "cancelled", "unknown"],
                         SPEC["components"]["schemas"]["RefundStatus"]["enum"])
        refund = {"id": UUID, "publicRefundNumber": "REF-20261116-AB12CD", "orderId": UUID,
                  "publicOrderNumber": "EZ-20261116-ABC123", "paymentId": UUID,
                  "publicPaymentNumber": "PAY-20261116-AB12CD", "channel": "manual", "providerCode": "manual_bank_transfer",
                  "environment": "production", "amountMinor": 10000, "currency": "HKD", "status": "refunded",
                  "reason": "Damage refund", "requestedBy": UUID, "approvedBy": UUID, "executedBy": UUID,
                  "approvedAt": NOW, "executedAt": NOW, "reference": "PAYOUT-1", "version": 3,
                  "createdAt": NOW, "updatedAt": NOW}
        self.assertEqual([], errors("AdminRefund", refund))
        self.assertTrue(errors("AdminRefund", dict(refund, amountMinor=0)))
        self.assertTrue(errors("AdminRefund", dict(refund, status="paid")))
        self.assertTrue(errors("AdminRefund", dict(refund, refundToCard="4242")))
        # 执行退款必须能说明“钱以什么凭据付出去的”，但凭据不是必填字段：线上渠道由适配器回执。
        execute = SPEC["paths"]["/admin/refunds/{id}/execute"]["post"]
        self.assertEqual("refund.execute", execute["x-permission"])
        self.assertEqual([{"AdminSession": [], "CsrfToken": []}], execute["security"])
        self.assertIn({"$ref": "#/components/parameters/IdempotencyKey"}, execute["parameters"])
        self.assertEqual([], errors("RefundExecuteRequest", {"reason": "Paid out", "reference": "PAYOUT-1"}))
        self.assertTrue(errors("RefundExecuteRequest", {"reason": ""}))

    def test_after_sales_writes_are_permissioned_and_idempotent(self):
        create = SPEC["paths"]["/admin/after-sales"]["post"]
        self.assertEqual("aftersales.manage", create["x-permission"])
        self.assertEqual([{"AdminSession": [], "CsrfToken": []}], create["security"])
        self.assertIn({"$ref": "#/components/parameters/IdempotencyKey"}, create["parameters"])
        approve = SPEC["paths"]["/admin/after-sales/{id}/approve"]["post"]
        self.assertEqual("aftersales.approve", approve["x-permission"])
        self.assertIn({"$ref": "#/components/parameters/IfMatch"}, approve["parameters"])
        for action in ("receive-return", "inspect", "return-shipment"):
            operation = SPEC["paths"][f"/admin/after-sales/{{id}}/{action}"]["post"]
            self.assertEqual("aftersales.inspect", operation["x-permission"])
            self.assertIn({"$ref": "#/components/parameters/IdempotencyKey"}, operation["parameters"])
        # 退款与案件审批是两个权限：受理售后不等于能批钱。
        refund = SPEC["paths"]["/admin/after-sales/{id}/refund"]["post"]
        self.assertEqual("refunds.create", refund["x-permission"])
        self.assertNotEqual(approve["x-permission"], refund["x-permission"])
        request = {"orderId": UUID, "caseType": "refund", "items": [{"orderItemId": UUID, "quantity": 1}],
                   "reason": "Damaged"}
        self.assertEqual([], errors("AfterSalesCreateRequest", request))
        self.assertTrue(errors("AfterSalesCreateRequest", dict(request, caseType="chargeback")))
        self.assertTrue(errors("AfterSalesCreateRequest", dict(request, items=[])))
        self.assertTrue(errors("AfterSalesCreateRequest", dict(request,
                                                                items=[{"orderItemId": UUID, "quantity": 0}])))
        # 申请行不接受“金额”字段：金额由服务端按订单行快照分摊。
        self.assertTrue(errors("AfterSalesCreateRequest", dict(request,
                                                                items=[{"orderItemId": UUID, "quantity": 1,
                                                                        "amountMinor": 1}])))

    def test_inventory_adjustments_are_signed_append_only_movements(self):
        adjust = SPEC["paths"]["/admin/inventory/adjustments"]["post"]
        self.assertEqual("inventory.adjust", adjust["x-permission"])
        self.assertEqual([{"AdminSession": [], "CsrfToken": []}], adjust["security"])
        self.assertIn({"$ref": "#/components/parameters/IdempotencyKey"}, adjust["parameters"])
        # 调整只接受增量：没有“把现存量设成 X”的字段。
        body = {"variantId": UUID, "delta": -3, "reason": "Stocktake loss", "expectedVersion": 2}
        self.assertEqual([], errors("InventoryAdjustmentRequest", body))
        self.assertEqual([], errors("InventoryAdjustmentRequest", dict(body, reasonCode="stocktake")))
        self.assertTrue(errors("InventoryAdjustmentRequest", dict(body, delta=0)))
        self.assertTrue(errors("InventoryAdjustmentRequest", dict(body, delta="3")))
        self.assertTrue(errors("InventoryAdjustmentRequest", dict(body, delta=-100001)))
        self.assertTrue(errors("InventoryAdjustmentRequest", dict(body, onHand=10)))
        self.assertTrue(errors("InventoryAdjustmentRequest", dict(body, reason="")))
        # 版本 0 表示该 SKU 还没有库存行；负版本没有意义。
        self.assertEqual([], errors("InventoryAdjustmentRequest", dict(body, expectedVersion=0)))
        self.assertTrue(errors("InventoryAdjustmentRequest", dict(body, expectedVersion=-1)))
        self.assertTrue(errors("InventoryAdjustmentRequest", dict(body, reasonCode="Stocktake Loss")))

    def test_inventory_movements_and_thresholds_share_one_closed_vocabulary(self):
        self.assertEqual(["return_restock", "return_damaged", "return_quarantine", "return_scrap", "adjustment"],
                         SPEC["components"]["schemas"]["InventoryMovementType"]["enum"])
        movement = {"id": UUID, "variantId": UUID, "type": "adjustment", "quantity": 3, "stockDelta": -3,
                    "onHandAfter": 7, "reason": "Stocktake loss", "createdAt": NOW}
        self.assertEqual([], errors("AdminStockMovement", movement))
        self.assertTrue(errors("AdminStockMovement", dict(movement, type="purchase")))
        self.assertTrue(errors("AdminStockMovement", dict(movement, quantity=0)))
        self.assertTrue(errors("AdminStockMovement", dict(movement, stockDelta=3.5)))
        item = {"variantId": UUID, "sku": "SKU-1", "productId": UUID, "productName": "Linen Shirt",
                "productStatus": "active", "variantStatus": "active", "onHand": 10, "reserved": 4, "available": 6,
                "lowStockLevel": 5, "lowStockVersion": 2, "lowStockState": "ok", "version": 3, "updatedAt": NOW}
        self.assertEqual([], errors("AdminInventoryItem", item))
        # 可售数由服务端算，客户端不能只给 onHand 就声称自己知道可售数。
        self.assertTrue(errors("AdminInventoryItem", {k: v for k, v in item.items() if k != "available"}))
        self.assertTrue(errors("AdminInventoryItem", dict(item, lowStockState="warning")))
        # 阈值写入用 body 里的版本（0 = 尚不存在），不占用库存版本。
        threshold = SPEC["paths"]["/admin/inventory/thresholds"]["patch"]
        self.assertEqual("inventory.manage", threshold["x-permission"])
        self.assertEqual([{"AdminSession": [], "CsrfToken": []}], threshold["security"])
        self.assertEqual([], errors("InventoryThresholdsPatchRequest",
                                    {"variantId": UUID, "lowStockLevel": 0, "expectedVersion": 0}))
        self.assertTrue(errors("InventoryThresholdsPatchRequest",
                               {"variantId": UUID, "lowStockLevel": -1, "expectedVersion": 0}))
        self.assertTrue(errors("InventoryThresholdsPatchRequest", {"variantId": UUID, "lowStockLevel": 5}))
        for path in ("/admin/inventory", "/admin/inventory/movements"):
            self.assertEqual("inventory.read", SPEC["paths"][path]["get"]["x-permission"])

    def test_coupon_admin_operations_are_permissioned_and_idempotent(self):
        expected = {
            ("/admin/coupons", "get"): "coupons.read",
            ("/admin/coupons", "post"): "coupons.manage",
            ("/admin/coupons/{id}", "get"): "coupons.read",
            ("/admin/coupons/{id}", "patch"): "coupons.manage",
            ("/admin/coupons/{id}/redemptions", "get"): "coupons.read",
            ("/admin/coupons/{id}/disable", "post"): "coupons.manage",
            ("/admin/coupon-batches", "post"): "coupons.issue",
            ("/admin/coupon-batches/{id}/issue", "post"): "coupons.issue",
        }
        for (path, method), permission in expected.items():
            operation = SPEC["paths"][path][method]
            self.assertEqual(permission, operation["x-permission"], path)
            security = [{"AdminSession": []}] if method == "get" else [{"AdminSession": [], "CsrfToken": []}]
            self.assertEqual(security, operation["security"], path)
        # 停用与发放是写操作：必须带幂等键；改券必须证明读到的版本，快照冻结依赖它。
        for path in ("/admin/coupons/{id}/disable", "/admin/coupon-batches/{id}/issue"):
            self.assertIn({"$ref": "#/components/parameters/IdempotencyKey"},
                          SPEC["paths"][path]["post"]["parameters"])
        self.assertIn({"$ref": "#/components/parameters/IfMatch"},
                      SPEC["paths"]["/admin/coupons/{id}"]["patch"]["parameters"])

    def test_coupon_write_requests_enforce_closed_discount_types_and_bounds(self):
        write = {"code": "WELCOME-10", "discountType": "percent", "discountValue": 1000,
                 "validFrom": NOW, "validUntil": "2026-12-31T23:59:59Z"}
        self.assertEqual([], errors("CouponWriteRequest", write))
        # 百分比用基点表示，10000 bps = 100% 是硬上限；超过就不是折扣而是倒贴。
        self.assertTrue(errors("CouponWriteRequest", dict(write, discountValue=10001)))
        self.assertEqual([], errors("CouponWriteRequest", dict(write, discountType="fixed", discountValue=500)))
        self.assertEqual([], errors("CouponWriteRequest", dict(write, discountType="fixed",
                                                               discountValue=100000000)))
        for key in ("code", "discountType", "discountValue", "validFrom", "validUntil"):
            invalid = copy.deepcopy(write)
            del invalid[key]
            self.assertTrue(errors("CouponWriteRequest", invalid), key)
        self.assertTrue(errors("CouponWriteRequest", dict(write, discountType="buy_one_get_one")))
        self.assertTrue(errors("CouponWriteRequest", dict(write, discountValue=0)))
        self.assertTrue(errors("CouponWriteRequest", dict(write, code="with space")))
        self.assertTrue(errors("CouponWriteRequest", dict(write, refundPolicy="rollback")))
        # 请求体不接受服务端字段：规则快照与核销计数只能由服务端生成。
        self.assertTrue(errors("CouponWriteRequest", dict(write, couponSnapshot={})))
        self.assertTrue(errors("CouponWriteRequest", dict(write, usage={"usedCount": 0})))
        # 补丁是部分更新，但必须至少改一个字段；且不允许任何未声明字段。
        self.assertEqual([], errors("CouponPatchRequest", {"discountValue": 1200}))
        self.assertTrue(errors("CouponPatchRequest", {}))
        self.assertTrue(errors("CouponPatchRequest", {"discountValue": 10001, "discountType": "percent"}))
        self.assertTrue(errors("CouponPatchRequest", {"reservedCount": 1}))

    def test_coupon_responses_keep_snapshots_and_contacts_out(self):
        usage = {"reservedCount": 1, "redeemedCount": 2, "releasedCount": 0, "expiredCount": 0,
                 "returnedCount": 0, "usedCount": 3}
        coupon = {"id": UUID, "code": "WELCOME-10", "codeMasked": "WE***10", "status": "active",
                  "discountType": "percent", "discountValue": 1000, "currency": "HKD",
                  "validFrom": NOW, "validUntil": "2026-12-31T23:59:59Z", "minSubtotalMinor": 5000,
                  "totalLimit": 100, "perCustomerLimit": 1, "eligibleProductIds": [], "eligibleCategoryIds": [],
                  "memberTierIds": [], "refundPolicy": "restore", "version": 2, "createdBy": UUID,
                  "createdAt": NOW, "updatedAt": NOW, "usage": usage}
        self.assertEqual([], errors("AdminCoupon", coupon))
        # 快照属于报价/订单，不属于券规则本身：这里一旦出现就说明读模型泄漏了。
        self.assertTrue(errors("AdminCoupon", dict(coupon, couponSnapshot={})))
        self.assertTrue(errors("AdminCoupon", dict(coupon, status="expired")))
        self.assertTrue(errors("AdminCoupon", dict(coupon, refundPolicy="rollback")))
        self.assertTrue(errors("AdminCoupon", {k: v for k, v in coupon.items() if k != "usage"}))
        self.assertTrue(errors("CouponUsage", dict(usage, usedCount=-1)))
        payload = {"data": {"items": [coupon], "nextCursor": None, "hasMore": False},
                   "meta": {"requestId": "req-test"}}
        self.assertEqual([], errors("CouponListEnvelope", payload))

    def test_coupon_redemptions_expose_only_masked_customer_reference(self):
        redemption = {"id": UUID, "orderId": UUID, "publicOrderNumber": "EZ-20261116-ABC123",
                      "status": "redeemed", "discountMinor": 1200, "currency": "HKD",
                      "customerRef": "9f2ab3c1", "reservedAt": NOW, "redeemedAt": NOW,
                      "releasedAt": None, "expiresAt": None, "ruleVersion": 2}
        self.assertEqual([], errors("AdminCouponRedemption", redemption))
        # 游客顾客的联系方式绝不能出现在核销记录里：只有不可逆摘要的前 8 位。
        for key in ("customerKey", "customerEmail", "customerPhone", "contact"):
            self.assertTrue(errors("AdminCouponRedemption", dict(redemption, **{key: "leak"})), key)
        self.assertTrue(errors("AdminCouponRedemption", dict(redemption, status="refunded")))
        self.assertTrue(errors("AdminCouponRedemption", dict(redemption, discountMinor=0)))
        payload = {"data": {"items": [redemption], "nextCursor": None, "hasMore": False},
                   "meta": {"requestId": "req-test"}}
        self.assertEqual([], errors("CouponRedemptionListEnvelope", payload))

    def test_coupon_batches_are_reviewed_writes(self):
        request = {"couponId": UUID, "channel": "email"}
        self.assertEqual([], errors("CouponBatchRequest", request))
        self.assertTrue(errors("CouponBatchRequest", dict(request, channel="wechat")))
        self.assertTrue(errors("CouponBatchRequest", dict(request, couponId="WELCOME-10")))
        issue = {"confirmedRecipientCount": 120}
        self.assertEqual([], errors("CouponBatchIssueRequest", issue))
        self.assertTrue(errors("CouponBatchIssueRequest", {}))
        self.assertTrue(errors("CouponBatchIssueRequest", dict(issue, confirmedRecipientCount=-1)))
        # 批量发放确认数不能由“顺便带上收件人列表”替代：收件人只能在建批时声明。
        self.assertTrue(errors("CouponBatchIssueRequest", dict(issue, recipientMemberIds=[UUID])))
        # 建批响应冻结人数与状态；issued 必须带确认数与发放时间，pending 不能带。
        batch = {"id": UUID, "couponId": UUID, "channel": "email", "recipientCount": 120,
                 "recipientMemberIds": [UUID], "status": "pending", "idempotencyKey": "batch:1",
                 "createdAt": "2026-11-18T00:00:00.000Z"}
        self.assertEqual([], errors("CouponBatch", batch))
        issued = dict(batch, status="issued", confirmedRecipientCount=120, issuedAt="2026-11-18T01:00:00.000Z")
        self.assertEqual([], errors("CouponBatch", issued))
        envelope = {"data": issued, "meta": {"requestId": "req-test"}}
        self.assertEqual([], errors("CouponBatchEnvelope", envelope))
        self.assertTrue(errors("CouponBatch", dict(batch, status="unknown")))
        self.assertTrue(errors("CouponBatch", dict(batch, recipientCount=-1)))

    def test_member_only_coupons_and_member_quota_are_typed(self):
        # 会员专属券的等级限制是 uuid 列表、不可重复；退役/未知等级由服务端拒绝。
        write = {"code": "VIP-10", "discountType": "percent", "discountValue": 1000,
                 "validFrom": "2026-11-01T00:00:00.000Z", "validUntil": "2026-12-01T00:00:00.000Z",
                 "memberTierIds": [UUID]}
        self.assertEqual([], errors("CouponWriteRequest", write))
        self.assertTrue(errors("CouponWriteRequest", dict(write, memberTierIds=["not-a-uuid"])))
        self.assertTrue(errors("CouponWriteRequest", dict(write, memberTierIds=[UUID, UUID])))
        # 报价请求不接受客户端指定顾客限额键，避免伪造会员主体绕过限额。
        quote = {"cartId": UUID, "locale": "zh-HK", "marketCode": "HK", "contact": {"email": "a@b.com"},
                 "shippingAddress": {"countryCode": "HK", "addressLine1": "1 Test Road"}, "shippingMethodId": UUID,
                 "policyAcceptances": []}
        self.assertEqual([], errors("CheckoutQuoteRequest", quote))
        self.assertTrue(errors("CheckoutQuoteRequest", dict(quote, couponCustomerKey="forged")))


    def test_report_key_is_a_closed_set_across_parameter_and_request(self):
        expected = ["sales_summary", "orders_by_status", "orders_by_payment", "orders_by_method",
                    "product_sales", "inventory", "coupons", "members", "funnel", "placement"]
        schemas = SPEC["components"]["schemas"]
        self.assertEqual(expected, schemas["ReportKey"]["enum"])
        self.assertEqual(expected, SPEC["components"]["parameters"]["ReportKey"]["schema"]["enum"])
        request = {"reportKey": "sales_summary", "from": NOW, "to": NOW, "timezone": "Asia/Hong_Kong", "format": "csv"}
        self.assertEqual([], errors("ReportExportRequest", request))
        self.assertTrue(errors("ReportExportRequest", dict(request, reportKey="drop_all_tables")))
        self.assertTrue(errors("ReportExportRequest", dict(request, includePii=True, unexpected=True)))
        # xlsx 在契约里是允许值，服务端首期可明确以 422 拒绝，但不能静默生成伪装成 Excel 的 CSV。
        self.assertEqual([], errors("ReportExportRequest", dict(request, format="xlsx")))

    def test_report_result_carries_definitions_coverage_and_no_identifiers(self):
        result = {
            "reportKey": "sales_summary", "metricDefinitionVersion": "1.0", "generatedAt": NOW,
            "from": NOW, "to": NOW, "timezone": "Asia/Hong_Kong", "currencies": ["HKD"],
            "filters": {"marketCode": "HK"},
            "totals": {"orderCount": 3, "placedAmountMinor": 59000, "collectedAmountMinor": 23000},
            "rows": [{"dimensions": {"status": "completed"}, "metrics": {"orderCount": 1, "placedAmountMinor": 10000}}],
            "coverage": {"sourceOrderCount": 3, "lastDataAt": NOW, "complete": True, "note": "ok"},
        }
        self.assertEqual([], errors("ReportResult", result))
        self.assertEqual([], errors("ReportEnvelope", {"data": result, "meta": {"requestId": "req-test"}}))
        # 报表不承载联系方式/会员号等标识字段；指标必须是数字。
        self.assertTrue(errors("ReportResult", dict(result, email="a@b.com")))
        self.assertTrue(errors("ReportResult", dict(result, totals={"orderCount": "3"})))
        self.assertTrue(errors("ReportRow", {"dimensions": {"email": "a@b.com"}, "metrics": {}}))
        # 覆盖率必须显式声明，不能让缺失数据被当成完整数据。
        missing = copy.deepcopy(result)
        del missing["coverage"]
        self.assertTrue(errors("ReportResult", missing))

    def test_report_export_status_never_exposes_permanent_download(self):
        export = {"id": UUID, "reportKey": "sales_summary", "format": "csv", "status": "completed",
                  "includePii": False, "filters": {}, "fileName": "sales.csv", "rowCount": 2,
                  "downloadUrl": "/api/v1/admin/report-exports/" + UUID + "/download",
                  "createdAt": NOW, "completedAt": NOW, "expiresAt": NOW}
        self.assertEqual([], errors("ReportExport", export))
        self.assertEqual([], errors("ReportExportEnvelope", {"data": export, "meta": {"requestId": "req-test"}}))
        self.assertTrue(errors("ReportExport", dict(export, status="running")))
        self.assertTrue(errors("ReportExport", dict(export, reportKey="unknown")))
        self.assertTrue(errors("ReportExport", dict(export, includePii="false")))
        # 进行中的任务不应带下载链接。
        self.assertEqual([], errors("ReportExport", dict(export, status="pending", downloadUrl=None, completedAt=None)))

    def test_funnel_is_in_report_key_closed_set_and_dimensions_allow_funnel_keys(self):
        expected = ["sales_summary", "orders_by_status", "orders_by_payment", "orders_by_method",
                    "product_sales", "inventory", "coupons", "members", "funnel", "placement"]
        self.assertEqual(expected, SPEC["components"]["schemas"]["ReportKey"]["enum"])
        self.assertEqual(expected, SPEC["components"]["parameters"]["ReportKey"]["schema"]["enum"])
        props = SPEC["components"]["schemas"]["ReportRow"]["properties"]["dimensions"]
        allowed = props["propertyNames"]["enum"]
        for key in ("step", "device", "source"):
            self.assertIn(key, allowed)

    def test_placement_report_and_section_events_are_closed_sets(self):
        # 区块事件必须带稳定 sectionKey/sectionId 与发布版本；字段闭集仍禁止任何 PII。
        event = {"eventId": UUID, "sessionId": "sess_abcdefghijklmnop", "eventName": "section_impression",
                 "occurredAt": NOW, "schemaVersion": "1.0", "consentState": "granted", "pageKey": "home",
                 "sectionId": "home:hero", "sectionKey": "home.hero", "publishVersionId": "rel-2026-11",
                 "environment": "production", "trafficClass": "human"}
        self.assertEqual([], errors("AnalyticsEventInput", event))
        self.assertEqual([], errors("AnalyticsEventInput", dict(
            event, eventName="section_click", placementId="card-1", interactionId=UUID)))
        self.assertTrue(errors("AnalyticsEventInput", dict(event, sectionKey=None)))
        self.assertTrue(errors("AnalyticsEventInput", dict(event, sectionKey="https://x/?q=1")))
        self.assertTrue(errors("AnalyticsEventInput", dict(event, environment="staging")))
        self.assertTrue(errors("AnalyticsEventInput", dict(event, trafficClass="robot")))
        # 加购归因只接受匿名区块标识与同意状态；不接受邮箱/电话/客户号。
        attribution = {"sectionId": "home:hero", "sectionKey": "home.hero", "publishVersionId": "rel-2026-11",
                       "interactionId": UUID, "consentState": "granted"}
        self.assertEqual([], errors("CartItemAttribution", attribution))
        self.assertEqual([], errors("CartItemWriteRequest",
                                    {"variantId": UUID, "quantity": 1, "attribution": attribution}))
        self.assertTrue(errors("CartItemAttribution", dict(attribution, email="a@b.com")))
        self.assertTrue(errors("CartItemAttribution", dict(attribution, interactionId="short")))
        # 区块分组维度是闭集：只允许区块/区块实例/页面/发布版本。
        ops = SPEC["paths"]["/admin/reports/{reportKey}"]["get"]["parameters"]
        group_by = next(p for p in ops if p.get("name") == "groupBy")["schema"]["enum"]
        for key in ("section", "sectionId", "page", "version"):
            self.assertIn(key, group_by)
        allowed = SPEC["components"]["schemas"]["ReportRow"]["properties"]["dimensions"]["propertyNames"]["enum"]
        for key in ("sectionKey", "sectionId", "page", "version"):
            self.assertIn(key, allowed)

    def test_analytics_ingest_rejects_pii_and_requires_consent_and_idempotency(self):
        op = SPEC["paths"]["/storefront/analytics/events"]["post"]
        self.assertEqual("public", op["x-authentication"])
        self.assertEqual("required", op["x-csrf"])
        event = {"eventId": UUID, "sessionId": "sess_abcdefghijklmnop", "eventName": "page_view",
                 "occurredAt": NOW, "schemaVersion": "1.0", "consentState": "granted", "pageKey": "home"}
        self.assertEqual([], errors("AnalyticsEventInput", event))
        self.assertEqual([], errors("AnalyticsEventBatch", {"events": [event]}))
        # 禁止把联系方式/URL/身份塞进事件：additionalProperties=false 且字段名不在闭集里。
        for bad in ({"email": "a@b.com"}, {"phone": "123"}, {"url": "https://x/?q=secret"},
                    {"customerId": UUID}, {"name": "ID"}):
            self.assertTrue(errors("AnalyticsEventInput", dict(event, **bad)))
        # 采购事件不能由浏览器上报（purchase 由服务端订单权威生成）。
        self.assertTrue(errors("AnalyticsEventInput", dict(event, eventName="purchase")))
        # 必须声明同意状态与幂等键、随机会话 ID（非邮箱形态）。
        for missing in ("consentState", "eventId", "sessionId", "schemaVersion"):
            broken = copy.deepcopy(event)
            del broken[missing]
            self.assertTrue(errors("AnalyticsEventInput", broken))
        self.assertTrue(errors("AnalyticsEventInput", dict(event, sessionId="a@b.com")))
        self.assertTrue(errors("AnalyticsEventBatch", {"events": []}))

    def test_carrier_webhook_is_signed_idempotent_and_pii_free(self):
        op = SPEC["paths"]["/webhooks/carriers/{carrierCode}"]["post"]
        self.assertEqual("public", op["x-authentication"])
        self.assertEqual("hmac-sha256", op["x-webhook-signature-validation"])
        self.assertEqual("carrier-event-id", op["x-idempotency"])
        params = {p["$ref"].rsplit("/", 1)[-1] for p in op["parameters"]}
        self.assertEqual({"CarrierCode", "CarrierTimestamp", "CarrierSignature"}, params)
        signature = SPEC["components"]["parameters"]["CarrierSignature"]["schema"]["pattern"]
        self.assertIn("v1=", signature)
        event = {"eventId": UUID, "shipmentId": UUID, "status": "out_for_delivery", "occurredAt": NOW}
        self.assertEqual([], errors("CarrierStatusEventRequest", event))
        self.assertEqual([], errors("CarrierStatusEventRequest", dict(event, trackingNumber="SF123", note="leave at door")))
        # 承运商回调不是顾客资料通道：联系方式、URL、支付凭证与内部状态字段一律拒绝。
        for bad in ({"email": "a@b.com"}, {"phone": "123"}, {"url": "https://x/?q=secret"},
                    {"customerId": UUID}, {"paymentStatus": "paid"}, {"orderStatus": "completed"}):
            self.assertTrue(errors("CarrierStatusEventRequest", dict(event, **bad)))
        self.assertTrue(errors("CarrierStatusEventRequest", dict(event, status="purchase")))
        for missing in ("eventId", "shipmentId", "status", "occurredAt"):
            broken = copy.deepcopy(event)
            del broken[missing]
            self.assertTrue(errors("CarrierStatusEventRequest", broken))
        ack = {"data": {"received": True, "duplicate": False, "shipmentStatus": "dispatched"},
               "meta": {"requestId": "req-test"}}
        self.assertEqual([], errors("CarrierWebhookAck", ack))
        self.assertTrue(errors("CarrierWebhookAck", dict(ack,
            data=dict(ack["data"], shipmentStatus="paid"))))

    def test_content_pages_publish_atomically_and_public_reads_hide_drafts(self):
        page = {"pageKey": "about", "pageType": "standard", "blocks": [
            {"id": "intro", "type": "rich_text", "visible": True, "position": 0,
             "config": {"heading": "關於", "paragraphs": ["內容"]}}],
            "translations": [{"locale": "zh-HK", "title": "關於我們", "slug": "about-hk", "indexable": True,
                              "seoTitle": None, "seoDescription": None}]}
        self.assertEqual([], errors("PageWriteRequest", page))
        # 三个字段都是发起草稿的必需信息：缺 blocks 或 translations 就不该建出空页面。
        for missing in ("pageKey", "pageType", "translations", "blocks"):
            broken = copy.deepcopy(page)
            del broken[missing]
            self.assertTrue(errors("PageWriteRequest", broken))
        # 索引开关是必填的显式决定，不能靠默认值让页面被随手收录。
        no_index = copy.deepcopy(page)
        del no_index["translations"][0]["indexable"]
        self.assertTrue(errors("PageWriteRequest", no_index))
        # 自造语言变体（zh-Hant）不属于闭集。
        hant = copy.deepcopy(page)
        hant["translations"][0]["locale"] = "zh-Hant"
        self.assertTrue(errors("PageWriteRequest", hant))

        publish = SPEC["paths"]["/admin/pages/{id}/publish"]["post"]
        self.assertEqual("content.publish", publish["x-permission"])
        self.assertEqual([{"AdminSession": [], "CsrfToken": []}], publish["security"])
        self.assertEqual([], errors("PagePublishRequest", {"expectedVersion": 2}))
        self.assertEqual([], errors("PagePublishRequest",
                                    {"expectedVersion": 2, "mode": "scheduled",
                                     "scheduledAt": "2026-11-20T01:00:00Z"}))
        self.assertTrue(errors("PagePublishRequest", {"expectedVersion": 2, "mode": "later"}))
        self.assertTrue(errors("PagePublishRequest", {"mode": "immediate"}))
        rollback = SPEC["paths"]["/admin/pages/{id}/rollback"]["post"]
        self.assertEqual("content.publish", rollback["x-permission"])
        self.assertEqual([], errors("PageRollbackRequest", {"sourceVersion": 2, "reason": "restore", "expectedVersion": 5}))
        self.assertTrue(errors("PageRollbackRequest", {"sourceVersion": 2, "expectedVersion": 5}))
        # 预览是单独的能力，不能靠 content.read 拿到草稿外链。
        preview = SPEC["paths"]["/admin/pages/{id}/preview-token"]["post"]
        self.assertEqual("content.preview", preview["x-permission"])

    def test_public_content_payload_is_release_only_and_theme_closed(self):
        listing = SPEC["paths"]["/storefront/pages"]["get"]
        # 公开清单是匿名读取：站点地图与页脚导航都要在未登录时可用。
        self.assertNotIn("security", listing)
        self.assertEqual("listStorefrontPages", listing["operationId"])
        public = SPEC["paths"]["/storefront/pages/{slug}"]["get"]
        self.assertNotIn("security", public)

        block = {"id": "intro", "type": "rich_text", "position": 0, "config": {"paragraphs": ["內容"]}}
        page = {"pageKey": "about", "pageType": "standard", "locale": "zh-HK", "slug": "about-hk",
                "title": "關於我們", "seoTitle": None, "seoDescription": None, "indexable": True,
                "blocks": [block], "alternates": [{"locale": "zh-HK", "slug": "about-hk"}],
                "version": 3, "contentRelease": "cr-12"}
        envelope = {"data": page, "meta": {"requestId": "req-test"}}
        self.assertEqual([], errors("PublicPageEnvelope", envelope))
        # 公开响应只认已注册的区块类型；未注册类型不会出现在快照里。
        for bad_type in ("custom_html", "product_grid", ""):
            self.assertTrue(errors("PublicPageEnvelope", dict(envelope,
                data=dict(page, blocks=[dict(block, type=bad_type)]))))
        # 公开响应不带草稿状态：visible/status 这类后台字段必须留在后台。
        self.assertTrue(errors("PublicPageEnvelope", dict(envelope,
            data=dict(page, blocks=[dict(block, visible=True)]))))
        self.assertTrue(errors("PublicPageEnvelope", dict(envelope, data=dict(page, status="draft"))))
        # 发布标记是内容版本号 cr-N；旧的固定主题标记不再合法。
        for bad_release in ("mrinhk-2026-11", "rel-1", "", None):
            self.assertTrue(errors("PublicPageEnvelope", dict(envelope, data=dict(page, contentRelease=bad_release))))
        summary = {"pageKey": "about", "pageType": "standard", "locale": "zh-HK", "slug": "about-hk",
                   "title": "關於我們", "indexable": True, "alternates": [{"locale": "zh-HK", "slug": "about-hk"}]}
        listing_payload = {"data": {"items": [summary], "locale": "zh-HK", "contentRelease": "cr-12"},
                           "meta": {"requestId": "req-test"}}
        self.assertEqual([], errors("PublicPageListEnvelope", listing_payload))
        self.assertTrue(errors("PublicPageListEnvelope", dict(listing_payload,
            data=dict(listing_payload["data"], contentRelease="theme-v1"))))


    def test_preview_links_are_version_scoped_and_never_indexable(self):
        token = "A" * 43
        preview = SPEC["paths"]["/admin/pages/{id}/preview-token"]["post"]
        self.assertEqual("content.preview", preview["x-permission"])
        self.assertEqual([{"AdminSession": [], "CsrfToken": []}], preview["security"])
        # 三个字段都必需：语言、视口、以及「后台正在看的草稿版本」。
        self.assertEqual([], errors("PreviewRequest", {"locale": "zh-HK", "viewport": "mobile", "expectedVersion": 3}))
        for missing in ("locale", "viewport", "expectedVersion"):
            broken = {"locale": "zh-HK", "viewport": "mobile", "expectedVersion": 3}
            del broken[missing]
            self.assertTrue(errors("PreviewRequest", broken))
        self.assertEqual([], errors("PreviewRequest", {"locale": "en", "viewport": "desktop",
                                                       "expectedVersion": 1, "ttlMinutes": 1440}))
        # 有效期有上下界：太短来不及复核，太长等于长期可访问的绕过入口。
        for ttl in (4, 1441, 0, -5):
            self.assertTrue(errors("PreviewRequest", {"locale": "en", "viewport": "desktop",
                                                      "expectedVersion": 1, "ttlMinutes": ttl}))
        # 预览结果里的地址只能是站内相对路径，且语言/视口写死在链接里。
        result = {"token": token, "path": f"/zh-HK/preview/{token}?viewport=mobile",
                  "locale": "zh-HK", "viewport": "mobile", "expiresAt": "2026-11-19T04:00:00Z", "pageVersion": 4}
        self.assertEqual([], errors("PreviewTokenResult", result))
        for bad in ("https://evil.example.test/preview/x", f"/preview/{token}?viewport=mobile",
                    f"/zh-Hant/preview/{token}?viewport=mobile", "/zh-HK/preview/short",
                    f"/zh-HK/preview/{token}?viewport=tablet"):
            self.assertTrue(errors("PreviewTokenResult", dict(result, path=bad)))
        self.assertTrue(errors("PreviewTokenResult", dict(result, token="short")))

        page = {"pageKey": "about", "pageType": "standard", "locale": "zh-HK", "slug": "about-hk",
                "title": "關於我們", "seoTitle": None, "seoDescription": None, "indexable": False,
                "blocks": [{"id": "intro", "type": "rich_text", "position": 0, "config": {"paragraphs": ["草稿內容"]}}],
                "alternates": [{"locale": "zh-HK", "slug": "about-hk"}], "version": 4,
                "preview": True, "viewport": "mobile", "expiresAt": "2026-11-19T04:00:00Z"}
        envelope = {"data": page, "meta": {"requestId": "req-test"}}
        self.assertEqual([], errors("PublicPreviewPageEnvelope", envelope))
        # 预览永远不可索引，也不能伪造 preview=false 拿到「像线上页面」的响应。
        self.assertTrue(errors("PublicPreviewPageEnvelope", dict(envelope, data=dict(page, indexable=True))))
        self.assertTrue(errors("PublicPreviewPageEnvelope", dict(envelope, data=dict(page, preview=False))))
        # 预览响应不带发布标记：草稿不属于任何线上版本。
        self.assertTrue(errors("PublicPreviewPageEnvelope", dict(envelope, data=dict(page, contentRelease="cr-9"))))
        # 预览是匿名只读入口：靠 token 鉴权，不要求后台会话。
        public = SPEC["paths"]["/storefront/preview/{token}"]["get"]
        self.assertNotIn("security", public)
        self.assertEqual("getStorefrontPreview", public["operationId"])

    def test_redirects_stay_on_site_and_reject_open_redirects(self):
        write = SPEC["paths"]["/admin/redirects"]["post"]
        self.assertEqual("content.publish", write["x-permission"])
        self.assertEqual([{"AdminSession": [], "CsrfToken": []}], write["security"])
        listing = SPEC["paths"]["/admin/redirects"]["get"]
        self.assertEqual("content.read", listing["x-permission"])
        delete = SPEC["paths"]["/admin/redirects/{id}"]["delete"]
        self.assertEqual("content.publish", delete["x-permission"])
        self.assertEqual([{"AdminSession": [], "CsrfToken": []}], delete["security"])

        body = {"locale": "zh-HK", "fromPath": "/zh-HK/pages/old-about", "toPath": "/zh-HK/pages/about"}
        self.assertEqual([], errors("RedirectWriteRequest", body))
        self.assertEqual([], errors("RedirectWriteRequest", dict(body, statusCode=308)))
        # 开放重定向防线：绝对地址、协议相对地址、查询串、片段、反斜杠一律不接受。
        for bad in ("https://evil.example.test/x", "//evil.example.test", "/a?next=https://evil.example.test",
                    "/a#frag", "/a\\b", "zh-HK/pages/about", ""):
            self.assertTrue(errors("RedirectWriteRequest", dict(body, toPath=bad)), bad)
        self.assertTrue(errors("RedirectWriteRequest", dict(body, statusCode=302)))
        self.assertTrue(errors("RedirectWriteRequest", dict(body, locale="zh-Hant")))

        public = SPEC["paths"]["/storefront/redirect"]["get"]
        self.assertNotIn("security", public)
        self.assertEqual("lookupStorefrontRedirect", public["operationId"])
        empty = {"data": {"redirect": None}, "meta": {"requestId": "req-test"}}
        self.assertEqual([], errors("PublicRedirectEnvelope", empty))
        hit = {"data": {"redirect": {"toPath": "/zh-HK/pages/about", "statusCode": 301}}, "meta": {"requestId": "req-test"}}
        self.assertEqual([], errors("PublicRedirectEnvelope", hit))
        # 公开响应也只允许站内路径与 301/308，不允许把解析结果变成任意跳转。
        self.assertTrue(errors("PublicRedirectEnvelope",
                               {"data": {"redirect": {"toPath": "https://evil.example.test", "statusCode": 301}},
                                "meta": {"requestId": "req-test"}}))
        self.assertTrue(errors("PublicRedirectEnvelope",
                               {"data": {"redirect": {"toPath": "/zh-HK/pages/about", "statusCode": 302}},
                                "meta": {"requestId": "req-test"}}))

    def test_merchandising_sections_are_closed_and_manual_order_cannot_smuggle_live_rules(self):
        publish = SPEC["paths"]["/admin/merchandising/{pageKey}/publish"]["post"]
        self.assertEqual("content.publish", publish["x-permission"])
        self.assertEqual([{"AdminSession": [], "CsrfToken": []}], publish["security"])
        draft = SPEC["paths"]["/admin/merchandising/{pageKey}"]["get"]
        self.assertEqual("content.read", draft["x-permission"])
        write = SPEC["paths"]["/admin/merchandising/{pageKey}"]["put"]
        self.assertEqual("content.write", write["x-permission"])

        section = {"sectionId": "featured", "type": "product_grid", "visible": True, "position": 0,
                   "titleByLocale": {"zh-HK": "本月精選", "en": "Featured"}, "sortMode": "manual", "limit": 6,
                   "productIds": [UUID], "categoryIds": []}
        body = {"expectedVersion": 1, "sections": [section]}
        self.assertEqual([], errors("MerchandisingWriteRequest", body))
        self.assertEqual([], errors("MerchandisingWriteRequest",
                                    {"expectedVersion": 2, "sections": [dict(section, sortMode="fulfilled_sales_30d",
                                                                             productIds=[])]}))
        # 版面只接受已注册的区块类型与已实现的排序口径。
        self.assertTrue(errors("MerchandisingWriteRequest", {"expectedVersion": 1,
                                                             "sections": [dict(section, type="custom_html")]}))
        self.assertTrue(errors("MerchandisingWriteRequest", {"expectedVersion": 1,
                                                             "sections": [dict(section, sortMode="random")]}))
        # 专题筛选只允许 uuid（手工区块再带专题筛选由领域层拒绝，契约层不管这个语义）。
        self.assertEqual([], errors("MerchandisingWriteRequest",
                                    {"expectedVersion": 1, "sections": [dict(section, sortMode="newest",
                                                                             productIds=[], collectionId=UUID)]}))
        self.assertTrue(errors("MerchandisingWriteRequest", {"expectedVersion": 1,
                                                             "sections": [dict(section, collectionId="summer")]}))
        self.assertTrue(errors("MerchandisingWriteRequest", {"expectedVersion": 1,
                                                             "sections": [dict(section, limit=25)]}))
        self.assertTrue(errors("MerchandisingWriteRequest", {"expectedVersion": 1,
                                                             "sections": [dict(section, script="alert(1)")]}))
        self.assertTrue(errors("MerchandisingWriteRequest", {"expectedVersion": 0, "sections": []}))

        public = SPEC["paths"]["/storefront/merchandising/{pageKey}"]["get"]
        self.assertNotIn("security", public)
        self.assertEqual("getStorefrontMerchandising", public["operationId"])
        page = {"pageKey": "home", "version": 3, "locale": "zh-HK", "marketCode": "HK",
                "sections": [{"sectionId": "featured", "type": "product_grid", "title": "本月精選",
                              "sortMode": "manual",
                              "products": [{"id": UUID, "slug": "cigar-1", "name": "雪茄一號",
                                            "variants": [], "media": [], "inStock": False}]}]}
        envelope = {"data": page, "meta": {"requestId": "req-test"}}
        self.assertEqual([], errors("PublicMerchandisingEnvelope", envelope))
        # 公开响应不允许带草稿字段（visible/position/productIds），也不允许未知 pageKey。
        self.assertTrue(errors("PublicMerchandisingEnvelope",
                               {"data": dict(page, sections=[dict(page["sections"][0], visible=True)]),
                                "meta": {"requestId": "req-test"}}))
        self.assertTrue(errors("PublicMerchandisingEnvelope",
                               {"data": dict(page, pageKey="collection:summer"), "meta": {"requestId": "req-test"}}))

    def test_category_merchandising_is_bound_by_id_and_layout_wins_over_listing(self):
        # 后台沿用同一组路径，但分类版面的 key 必须是 category:<uuid>；用 slug 会在改名后失联。
        for suffix in ("", "/publish", "/unpublish"):
            path = SPEC["paths"][f"/admin/merchandising/{{pageKey}}{suffix}"]
            self.assertIn(("put" if suffix == "" else "post"), path)
        key_param = next(item for item in SPEC["components"]["parameters"].values() if item["name"] == "pageKey")
        pattern = key_param["schema"]["pattern"]
        self.assertTrue(re.match(pattern, "home"))
        self.assertTrue(re.match(pattern, f"category:{UUID}"))
        self.assertTrue(re.match(pattern, f"collection:{UUID}"))
        self.assertFalse(re.match(pattern, "category:cigars"))
        self.assertFalse(re.match(pattern, "collection:summer"))

        pages = SPEC["paths"]["/admin/merchandising/pages"]["get"]
        self.assertEqual("content.read", pages["x-permission"])
        self.assertEqual([{"AdminSession": []}], pages["security"])
        products = SPEC["paths"]["/admin/merchandising/products"]["get"]
        self.assertIn("categoryId", [item.get("name") for item in products["parameters"]])

        public = SPEC["paths"]["/storefront/categories/{slug}"]["get"]
        self.assertEqual("getStorefrontCategory", public["operationId"])
        self.assertNotIn("security", public)

        category = {"id": UUID, "parentId": None, "name": "雪茄", "slug": "cigars", "description": None, "position": 0}
        section = {"sectionId": "featured", "type": "product_grid", "title": "本月精選", "sortMode": "manual",
                   "products": [{"id": UUID, "slug": "cigar-1", "name": "雪茄一號", "variants": [], "media": [],
                                 "inStock": True}]}
        envelope = {"data": {"category": category, "alternates": [{"locale": "zh-HK", "slug": "cigars"}],
                             "layout": {"version": 2, "sections": [section]}, "products": [],
                             "locale": "zh-HK", "marketCode": "HK", "contentRelease": "cr-7"},
                    "meta": {"requestId": "req-test"}}
        self.assertEqual([], errors("PublicCategoryEnvelope", envelope))
        # 没发布版面时给平铺商品：layout 为 null，商品数组才允许非空。
        fallback = {"data": {"category": category, "alternates": [{"locale": "zh-HK", "slug": "cigars"}],
                             "layout": None, "contentRelease": "cr-7",
                             "products": [{"id": UUID, "slug": "cigar-1", "name": "雪茄一號", "variants": [], "media": [],
                                           "inStock": True}], "locale": "zh-HK", "marketCode": "HK"},
                    "meta": {"requestId": "req-test"}}
        self.assertEqual([], errors("PublicCategoryEnvelope", fallback))
        # 版面里不能夹带草稿字段，也不能出现未知分类字段（公开响应不是编辑器接口）。
        self.assertTrue(errors("PublicCategoryEnvelope",
                               {"data": {"category": dict(category, enabled=False),
                                         "alternates": [{"locale": "zh-HK", "slug": "cigars"}], "layout": None,
                                         "products": [], "locale": "zh-HK", "marketCode": "HK",
                                         "contentRelease": "cr-7"}, "meta": {"requestId": "req-test"}}))
        self.assertTrue(errors("PublicCategoryEnvelope",
                               {"data": {"category": category, "alternates": [{"locale": "zh-HK", "slug": "cigars"}],
                                         "layout": {"version": 2, "sections": [dict(section, position=0)]},
                                         "products": [], "locale": "zh-HK", "marketCode": "HK",
                                         "contentRelease": "cr-7"},
                                "meta": {"requestId": "req-test"}}))

    def test_collections_are_curated_by_id_and_slug_changes_keep_a_301(self):
        # 专题沿用内容域权限：策展是内容运营动作，不是商品目录维护。
        listing = SPEC["paths"]["/admin/collections"]["get"]
        create = SPEC["paths"]["/admin/collections"]["post"]
        self.assertEqual("content.read", listing["x-permission"])
        self.assertEqual("content.write", create["x-permission"])
        self.assertEqual([{"AdminSession": [], "CsrfToken": []}], create["security"])
        patch = SPEC["paths"]["/admin/collections/{id}"]["patch"]
        self.assertIn({"$ref": "#/components/parameters/IfMatch"}, patch["parameters"])
        self.assertIn("delete", SPEC["paths"]["/admin/collections/{id}"])

        body = {"translations": [{"locale": "zh-HK", "name": "秋日選物", "slug": "autumn-picks"},
                                 {"locale": "en", "name": "Autumn picks"}],
                "productIds": [UUID], "enabled": True, "position": 0}
        self.assertEqual([], errors("CollectionWriteRequest", body))
        # slug 是前台地址：只接受小写短横线形式，草稿可以先不写。
        self.assertTrue(errors("CollectionWriteRequest",
                               {"translations": [{"locale": "zh-HK", "name": "秋日選物", "slug": "Autumn Picks"}]}))
        self.assertTrue(errors("CollectionWriteRequest", {"translations": []}))
        self.assertTrue(errors("CollectionWriteRequest", {"productIds": ["not-a-uuid"]}))
        self.assertTrue(errors("CollectionPatchRequest", {}))
        self.assertEqual([], errors("CollectionPatchRequest", {"enabled": False}))
        # 未知字段会被拒绝：专题没有「图片位」之类还没实现的配置。
        self.assertTrue(errors("CollectionPatchRequest", {"coverMediaId": UUID}))

        view = {"id": UUID, "position": 0, "enabled": True, "version": 3,
                "translations": [{"locale": "zh-HK", "name": "秋日選物", "slug": "autumn-picks",
                                  "description": None}],
                "productIds": [UUID], "productCount": 1,
                "createdAt": "2026-11-20T02:00:00.000Z", "updatedAt": "2026-11-20T02:00:00.000Z"}
        self.assertEqual([], errors("CollectionEnvelope", {"data": view, "meta": {"requestId": "req-test"}}))
        self.assertTrue(errors("CollectionEnvelope",
                               {"data": dict(view, internalNote="x"), "meta": {"requestId": "req-test"}}))

        public_list = SPEC["paths"]["/storefront/collections"]["get"]
        self.assertNotIn("security", public_list)
        summary = {"id": UUID, "name": "秋日選物", "slug": "autumn-picks", "description": None, "position": 0,
                   "productCount": 2, "alternates": [{"locale": "zh-HK", "slug": "autumn-picks"}]}
        self.assertEqual([], errors("PublicCollectionListEnvelope",
                                    {"data": {"items": [summary], "locale": "zh-HK"},
                                     "meta": {"requestId": "req-test"}}))
        # 空专题不进前台列表，因此 productCount 至少为 1。
        self.assertTrue(errors("PublicCollectionListEnvelope",
                               {"data": {"items": [dict(summary, productCount=0)], "locale": "zh-HK"},
                                "meta": {"requestId": "req-test"}}))

        page = {"collection": {"id": UUID, "name": "秋日選物", "slug": "autumn-picks", "description": None,
                              "position": 0},
                "alternates": [{"locale": "zh-HK", "slug": "autumn-picks"}],
                "layout": None, "products": [], "locale": "zh-HK", "marketCode": "HK", "contentRelease": "cr-9"}
        self.assertEqual([], errors("PublicCollectionEnvelope",
                                    {"data": page, "meta": {"requestId": "req-test"}}))
        # 公开响应不是编辑器接口：后台字段（enabled/version/productIds）不能混进来。
        self.assertTrue(errors("PublicCollectionEnvelope",
                               {"data": dict(page, collection=dict(page["collection"], enabled=True)),
                                "meta": {"requestId": "req-test"}}))

if __name__ == "__main__":
    unittest.main()
