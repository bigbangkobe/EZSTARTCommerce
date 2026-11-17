// Generated from openapi.yaml. Run pnpm contracts:generate; do not edit.
export interface paths {
    "/admin/users/{id}/invitation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** getAdminInvitation */
        get: operations["getAdminInvitation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/users/{id}/invitation/resend": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** resendAdminInvitation */
        post: operations["resendAdminInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/users/{id}/invitation/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** revokeAdminInvitation */
        post: operations["revokeAdminInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/store-config/markets/{marketCode}/reviews": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** recordMarketReview */
        post: operations["recordMarketReview"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Process liveness */
        get: operations["getHealthLive"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health/ready": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Dependency readiness
         * @description Returns 200 only when the configured identity database and checked migrations are ready. Without identity configuration returns 503 SERVICE_NOT_READY. Process liveness is not readiness.
         */
        get: operations["getHealthReady"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/auth/bootstrap": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Provision the first owner only while deployment setup is enabled */
        post: operations["bootstrapAdminOwner"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/auth/invitations/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Consume an invitation and set password; mandatory MFA yields setup only */
        post: operations["acceptAdminInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/auth/mfa/enrollment-authorizations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reauthenticate current user before optional MFA enrollment or factor replacement */
        post: operations["authorizeAdminMfaEnrollment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/auth/mfa/enrollments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a pending TOTP factor; each start invalidates earlier pending enrollment */
        post: operations["startAdminMfaEnrollment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/auth/mfa/enrollments/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Verify pending TOTP, atomically activate it and issue one-time recovery codes */
        post: operations["confirmAdminMfaEnrollment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/auth/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List only current user active sessions */
        get: operations["listOwnAdminSessions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/auth/sessions/{id}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke a session belonging only to the current user */
        post: operations["revokeOwnAdminSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/users/{id}/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List active sessions for an authorized staff user */
        get: operations["listAdminUserSessions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Authenticate an admin user */
        post: operations["adminLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/auth/mfa/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Verify a TOTP code or one-time recovery code */
        post: operations["verifyAdminMfa"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/auth/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the current admin session and permission summary */
        get: operations["getAdminSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke the current admin session */
        post: operations["logoutAdmin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/auth/password-reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Request a one-time password reset */
        post: operations["requestAdminPasswordReset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List admin users */
        get: operations["listAdminUsers"];
        put?: never;
        /** Invite a staff user */
        post: operations["inviteAdminUser"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/users/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        /** Get an admin user */
        get: operations["getAdminUser"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update or deactivate an admin user */
        patch: operations["updateAdminUser"];
        trace?: never;
    };
    "/admin/users/{id}/sessions/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke all sessions for an admin user */
        post: operations["revokeAdminUserSessions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/roles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List roles and permission codes */
        get: operations["listRoles"];
        put?: never;
        /** Create a role */
        post: operations["createRole"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/roles/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        /** Get a role */
        get: operations["getRole"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update a role */
        patch: operations["updateRole"];
        trace?: never;
    };
    "/admin/store-config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get store configuration */
        get: operations["getStoreConfig"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update store configuration */
        patch: operations["updateStoreConfig"];
        trace?: never;
    };
    "/admin/products": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List products */
        get: operations["listProducts"];
        put?: never;
        /** Create a product draft */
        post: operations["createProduct"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/products/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        /** Get product details */
        get: operations["getProduct"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update a product draft */
        patch: operations["updateProduct"];
        trace?: never;
    };
    "/admin/products/{id}/publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Publish a product */
        post: operations["publishProduct"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/products/{id}/unpublish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Unpublish a product */
        post: operations["unpublishProduct"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/categories": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List categories */
        get: operations["listCategories"];
        put?: never;
        /** Create a category */
        post: operations["createCategory"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/categories/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        /** Get a category */
        get: operations["getCategory"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update a category */
        patch: operations["updateCategory"];
        trace?: never;
    };
    "/admin/brands": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List brands */
        get: operations["listBrands"];
        put?: never;
        /** Create a brand */
        post: operations["createBrand"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/brands/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        /** Get a brand */
        get: operations["getBrand"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update a brand */
        patch: operations["updateBrand"];
        trace?: never;
    };
    "/admin/media": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List uploaded media assets */
        get: operations["listMedia"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/media/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get one media asset and its short-lived read URL */
        get: operations["getMedia"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/media/upload-target": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a short-lived upload target */
        post: operations["createMediaUploadTarget"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/media/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Verify and register an uploaded media object */
        post: operations["completeMediaUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/pages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List content pages */
        get: operations["listPages"];
        put?: never;
        /** Create a page draft */
        post: operations["createPage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/pages/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        /** Get a page draft or published version */
        get: operations["getPage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update a page draft */
        patch: operations["updatePage"];
        trace?: never;
    };
    "/admin/pages/{id}/preview-token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a short-lived page preview URL */
        post: operations["createPagePreviewToken"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/pages/{id}/publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Publish a page immediately or on schedule */
        post: operations["publishPage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/pages/{id}/unpublish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Withdraw the current published page version */
        post: operations["unpublishPage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/pages/{id}/rollback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Publish a new version copied from a prior page version */
        post: operations["rollbackPage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/merchandising/{pageKey}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                pageKey: components["parameters"]["PageKey"];
            };
            cookie?: never;
        };
        /** Get page merchandising draft */
        get: operations["getMerchandisingDraft"];
        /** Replace merchandising configuration draft for one page */
        put: operations["saveMerchandisingDraft"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/import-jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a product import job */
        post: operations["createImportJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/import-jobs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        /** Get import job state and counters */
        get: operations["getImportJob"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/import-jobs/{id}/validate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Validate an import and return a row preview without writing products */
        post: operations["validateImportJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/import-jobs/{id}/execute": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Execute the confirmed import preview */
        post: operations["executeImportJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/import-jobs/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel an import job that has not completed */
        post: operations["cancelImportJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/import-jobs/{id}/error-report": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a short-lived download for an import error report */
        get: operations["getImportErrorReport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/export-jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a permission-checked data export job */
        post: operations["createExportJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/export-jobs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get export job state and expiring download link */
        get: operations["getExportJob"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get public, enabled storefront configuration */
        get: operations["getPublicStoreConfig"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/products": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List published products available in the selected market */
        get: operations["listStorefrontProducts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/products/{slug}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get one published product by locale-specific slug */
        get: operations["getStorefrontProduct"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/categories": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List public categories */
        get: operations["listStorefrontCategories"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/pages/{slug}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a published content page */
        get: operations["getStorefrontPage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/collections/{slug}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a published collection and eligible product list */
        get: operations["getStorefrontCollection"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/cart": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the active guest cart */
        get: operations["getCart"];
        put?: never;
        /** Create a guest cart session */
        post: operations["createCart"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/cart/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Add a variant and quantity to the guest cart */
        post: operations["addCartItem"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/cart/items/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove an item from the guest cart */
        delete: operations["removeCartItem"];
        options?: never;
        head?: never;
        /** Change item quantity */
        patch: operations["updateCartItem"];
        trace?: never;
    };
    "/storefront/checkout/shipping-methods": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List delivery methods available for the guest cart and destination */
        get: operations["listCheckoutShippingMethods"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/checkout/quote": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Calculate an authoritative checkout quote */
        post: operations["createCheckoutQuote"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/checkout/orders": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create exactly one order from a confirmed quote */
        post: operations["createOrderFromQuote"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/member/otp/request": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Request an email OTP without revealing membership existence */
        post: operations["requestMemberOtp"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/member/otp/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Verify a one-time member code */
        post: operations["verifyMemberOtp"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/member/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke the current member session */
        post: operations["logoutMember"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/member/profile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get the authenticated member profile
         * @description Returns the member identity, loyalty summary and the session-derived CSRF token. The token is read from the same origin only, so a reloaded page can still log out safely.
         */
        get: operations["getMemberProfile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/member/orders": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List order summaries for the authenticated member */
        get: operations["listMemberOrders"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/member/points": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get member points balance and ledger summary */
        get: operations["getMemberPoints"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storefront/member/coupons": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List coupons assigned to the authenticated member */
        get: operations["listMemberCoupons"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/webhooks/payments/{provider}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Receive, verify, de-duplicate and enqueue a provider webhook */
        post: operations["receivePaymentWebhook"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/orders": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search and filter orders */
        get: operations["listOrders"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/orders/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an order snapshot and status history */
        get: operations["getOrder"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/orders/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel an eligible order */
        post: operations["cancelOrder"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/orders/{id}/address-change": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Change an address before shipment after re-validating delivery and price */
        post: operations["changeOrderAddress"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/orders/{id}/notes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Add an internal order note */
        post: operations["addOrderNote"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/orders/{id}/shipments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a parcel containing a subset of order lines */
        post: operations["createShipment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/shipments/{id}/dispatch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Mark parcel dispatched and commit shipped inventory quantities */
        post: operations["dispatchShipment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/shipments/{id}/deliver": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record delivery evidence; this does not collect COD payment */
        post: operations["deliverShipment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/payments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List payment ledger entries */
        get: operations["listPayments"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/payments/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a payment and its event history */
        get: operations["getPayment"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/payment-methods": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List payment methods with redacted credential status */
        get: operations["listPaymentMethods"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Configure or enable one approved payment adapter */
        patch: operations["updatePaymentMethod"];
        trace?: never;
    };
    "/admin/orders/{id}/payment-result": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record a COD, manual-transfer or return outcome against an order payment
         * @description Records money that has actually changed hands. The amount must equal the order total in the order currency; the request carries the order version it was based on. Unknown provider states cannot be forced to failed or succeeded here.
         */
        post: operations["recordOrderPaymentResult"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/refunds": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List refund ledger entries */
        get: operations["listRefunds"];
        put?: never;
        /**
         * Request a refund without exceeding the refundable amount
         * @description Money may only be refunded against a payment that actually settled. The amount is capped by the settled balance minus refunds already made or still in flight; the order total is not the limit. Requests carry an Idempotency-Key so a retry cannot book a second refund.
         */
        post: operations["createRefund"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/refunds/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a refund and its event history */
        get: operations["getRefund"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/refunds/{id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve a pending refund
         * @description The approver must differ from the requester. Approval only moves the ledger state; money is moved by a separate execute step under refund.execute.
         */
        post: operations["approveRefund"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/refunds/{id}/reject": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reject a pending refund with a reason */
        post: operations["rejectRefund"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/refunds/{id}/execute": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Execute an approved refund through its original payment channel
         * @description Offline channels (cash on delivery, manual transfer) record a payout that already happened and therefore require a payout reference. Online channels without a configured adapter answer 503 rather than pretending the refund succeeded. An unknown provider state cannot be forced.
         */
        post: operations["executeRefund"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/settlements": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List settlement batches */
        get: operations["listSettlements"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/settlements/import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Upload and parse a settlement file without confirming ledger matches */
        post: operations["importSettlement"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/settlements/{id}/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Preview settlement reconciliation results */
        post: operations["previewSettlement"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/settlements/{id}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Confirm a reviewed settlement batch */
        post: operations["confirmSettlement"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/settlements/{id}/lines/{lineId}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resolve a settlement difference with a reason */
        post: operations["resolveSettlementDifference"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/shipping/zones": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List shipping zones */
        get: operations["listShippingZones"];
        put?: never;
        /** Create a shipping zone */
        post: operations["createShippingZone"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/shipping/zones/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        /** Get a shipping zone */
        get: operations["getShippingZone"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update a shipping zone */
        patch: operations["updateShippingZone"];
        trace?: never;
    };
    "/admin/shipping/rates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List shipping rates */
        get: operations["listShippingRates"];
        put?: never;
        /** Create a shipping method rate */
        post: operations["createShippingRate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/shipping/rates/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        /** Get a shipping rate */
        get: operations["getShippingRate"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update a shipping rate */
        patch: operations["updateShippingRate"];
        trace?: never;
    };
    "/admin/shipping/quote-preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Preview shipping availability and price without creating an order */
        post: operations["previewShippingQuote"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/customers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search customers with field-level masking */
        get: operations["listCustomers"];
        put?: never;
        /** Create a customer record for an authorized operational purpose */
        post: operations["createCustomer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/customers/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        /** Get a customer record according to field-level permission */
        get: operations["getCustomer"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update an authorized customer profile field */
        patch: operations["updateCustomer"];
        trace?: never;
    };
    "/admin/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List member profiles */
        get: operations["listMembers"];
        put?: never;
        /** Create a member profile only after verified contact and consent */
        post: operations["createMemberProfile"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/members/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update member status or tier under audit */
        patch: operations["updateMember"];
        trace?: never;
    };
    "/admin/members/{id}/points": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one member's point balance and recent ledger entries */
        get: operations["getAdminMemberPoints"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/members/{id}/points-adjustments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Append an audited member point adjustment */
        post: operations["adjustMemberPoints"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/loyalty": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read point earning settings and the membership tier ladder */
        get: operations["getLoyaltyOverview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/loyalty/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Change point earning settings; only future calculations are affected */
        patch: operations["updateLoyaltySettings"];
        trace?: never;
    };
    "/admin/loyalty/tiers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Add a membership tier to the ladder */
        post: operations["createMembershipTier"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/loyalty/tiers/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Change a tier under version control; history keeps its rule version */
        patch: operations["updateMembershipTier"];
        trace?: never;
    };
    "/admin/privacy-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Register a privacy request for identity verification */
        post: operations["createPrivacyRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/privacy-requests/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a privacy request and status history */
        get: operations["getPrivacyRequest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/privacy-requests/{id}/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record identity verification for a privacy request */
        post: operations["verifyPrivacyRequestIdentity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/privacy-requests/{id}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Complete approved privacy-request processing */
        post: operations["completePrivacyRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/coupons": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List coupon rules */
        get: operations["listCoupons"];
        put?: never;
        /** Create a coupon rule */
        post: operations["createCoupon"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/coupons/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        /** Get coupon rule and usage summary */
        get: operations["getCoupon"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update a coupon rule without rewriting existing order snapshots */
        patch: operations["updateCoupon"];
        trace?: never;
    };
    "/admin/coupons/{id}/redemptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List redemptions and reservation states */
        get: operations["listCouponRedemptions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/coupons/{id}/disable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Disable a coupon for new uses */
        post: operations["disableCoupon"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/coupon-batches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a coupon issue batch */
        post: operations["createCouponBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/coupon-batches/{id}/issue": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Issue coupons in a reviewed batch */
        post: operations["issueCouponBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/inventory": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List SKU stock, reservations and low-stock thresholds
         * @description Every variant appears, including ones that were never stocked (on hand 0, version 0). Available = onHand - reserved is computed server-side and is the only number clients should use; lowStock=1 keeps rows whose available is at or below the threshold.
         */
        get: operations["listInventory"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/inventory/movements": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List immutable stock movements */
        get: operations["listStockMovements"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/inventory/adjustments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Append an inventory adjustment movement
         * @description Adjustments are deltas, never absolute values. A decrease may not eat reserved units: available must stay at or above zero. The request carries the inventory version the operator saw, so a concurrent adjustment fails instead of overwriting it.
         */
        post: operations["createInventoryAdjustment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/inventory/thresholds": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List low-stock thresholds that were explicitly set */
        get: operations["getInventoryThresholds"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Set the low-stock threshold of one SKU
         * @description The threshold only drives alerts, never availability. The expected version lives in the body because a threshold may not exist yet: 0 means "I expect no row", N means the version the operator read.
         */
        patch: operations["updateInventoryThresholds"];
        trace?: never;
    };
    "/admin/notification-settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get notification channels and templates */
        get: operations["getNotificationSettings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update notification channel or template configuration */
        patch: operations["updateNotificationSettings"];
        trace?: never;
    };
    "/admin/notification-jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List notification job status and attempts */
        get: operations["listNotificationJobs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/notification-jobs/{id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry only the notification delivery, not its source business action */
        post: operations["retryNotificationJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/reports/{reportKey}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Query a report using its metric definition and filters */
        get: operations["getReport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/report-exports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create an asynchronous report export */
        post: operations["createReportExport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/report-exports/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get report export status and short-lived download URL */
        get: operations["getReportExport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/audit-logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search immutable audit records
         * @description Newest first. Read-only by design; there is no update or delete endpoint for audit records.
         */
        get: operations["listAuditLogs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get restricted health and readiness checks */
        get: operations["getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/operations/backup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Start an authorized backup job */
        post: operations["createBackupJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/operations/jobs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an authorized operation job status */
        get: operations["getOperationJob"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/after-sales": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List after-sales cases */
        get: operations["listAfterSalesCases"];
        put?: never;
        /**
         * Create an after-sales case linked to an order
         * @description The server computes the selectable quantities from the order lines minus quantities already requested by other live cases of the same order; the client cannot ask for more.
         */
        post: operations["createAfterSalesCase"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/after-sales/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an after-sales case and its history */
        get: operations["getAfterSalesCase"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/after-sales/{id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve an eligible after-sales case
         * @description Approving a cancellation case cancels the order and releases its inventory hold; that is only allowed while the order is unshipped and unpaid. Other case types lock the approved quantities and refundable amount without moving any money.
         */
        post: operations["approveAfterSalesCase"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/after-sales/{id}/reject": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reject an after-sales case with an audited reason */
        post: operations["rejectAfterSalesCase"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/after-sales/{id}/return-shipment": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record the carrier and tracking number of a return parcel */
        post: operations["registerAfterSalesReturnShipment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/after-sales/{id}/receive-return": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record physical receipt of returned items
         * @description Receiving does not change sellable stock. Quantities are capped by what the case approved and by what has not already been received.
         */
        post: operations["receiveAfterSalesReturn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/after-sales/{id}/inspect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record item inspection and inventory disposition
         * @description Only sellable quantities return to on-hand stock; damaged, quarantined and scrapped items are recorded as a disposition movement without increasing sellable stock.
         */
        post: operations["inspectAfterSalesReturn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/after-sales/{id}/refund": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Request refund for an approved after-sales case
         * @description The payment is chosen by the server from settled payments of the order. The amount is capped by both the case approval and the refundable balance of that payment.
         */
        post: operations["refundAfterSalesCase"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/after-sales/{id}/close": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Close a case once no refund is still in flight */
        post: operations["closeAfterSalesCase"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        ReadinessStatusEnvelope: {
            data: {
                /** @constant */
                status: "ready";
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminInvitationSummary: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            userId: string;
            /** @enum {string} */
            status: "pending" | "accepted" | "revoked" | "expired";
            version: number;
            /** Format: date-time */
            expiresAt: string;
            /** Format: date-time */
            lastSentAt: string;
            /** Format: uuid */
            notificationJobId: string | null;
        };
        MarketReviewRequest: {
            /** @enum {string} */
            decision: "approved" | "rejected" | "revoked";
            evidenceReference: string;
            reason: string;
            /** Format: date-time */
            validUntil: string | null;
            confirmedMarketCode: string;
        };
        MarketReviewRecord: {
            /** Format: uuid */
            id: string;
            marketCode: string;
            /** @enum {string} */
            decision: "approved" | "rejected" | "revoked";
            evidenceReference: string;
            reason: string;
            /** Format: uuid */
            reviewedBy: string;
            /** Format: date-time */
            reviewedAt: string;
            /** Format: date-time */
            validUntil: string | null;
            storeConfigVersion: number;
        };
        HealthStatus: {
            /** @constant */
            status: "alive";
        };
        AdminInvitationSummaryEnvelope: {
            data: components["schemas"]["AdminInvitationSummary"];
            meta: components["schemas"]["ResponseMeta"];
        };
        MarketReviewRecordEnvelope: {
            data: components["schemas"]["MarketReviewRecord"];
            meta: components["schemas"]["ResponseMeta"];
        };
        HealthStatusEnvelope: {
            data: components["schemas"]["HealthStatus"];
            meta: components["schemas"]["ResponseMeta"];
        };
        BootstrapOwnerRequest: {
            /** Format: email */
            email: string;
            displayName: string;
            password: string;
            /** @enum {string} */
            locale: "zh-CN" | "zh-HK" | "en";
        };
        AcceptAdminInvitationRequest: {
            invitationToken: string;
            newPassword: string;
        };
        AdminMfaSetupChallenge: {
            /** Format: uuid */
            challengeId: string;
            /** @constant */
            nextAction: "enroll_mfa";
            /** Format: date-time */
            expiresAt: string;
        };
        AuthorizeMfaEnrollmentRequest: {
            currentPassword: string;
            currentMfaCode?: string;
        };
        StartMfaEnrollmentRequest: {
            /** Format: uuid */
            challengeId: string;
        };
        ConfirmMfaEnrollmentRequest: {
            /** Format: uuid */
            challengeId: string;
            /** Format: uuid */
            enrollmentId: string;
            code: string;
        };
        AdminMfaEnrollment: {
            /** Format: uuid */
            enrollmentId: string;
            /** Format: date-time */
            expiresAt: string;
            /** @description One-time TOTP provisioning secret; never log/cache. Store encrypted, not as a hash, to verify subsequent TOTP codes. */
            readonly totpSecret: string;
            /** Format: uri */
            readonly provisioningUri: string;
        };
        AdminMfaEnrollmentConfirmed: {
            session: components["schemas"]["AdminSessionData"];
            /** @description Shown only on successful enrollment confirmation. Server stores only hashes; never return on session or staff reads. */
            recoveryCodes: string[];
        };
        AdminSessionView: {
            /** Format: uuid */
            id: string;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            lastSeenAt: string;
            /** Format: date-time */
            idleExpiresAt: string;
            /** Format: date-time */
            absoluteExpiresAt: string;
            current: boolean;
        };
        AdminSessionRevoked: {
            /** Format: uuid */
            sessionId: string;
            /** Format: date-time */
            revokedAt: string;
        };
        AdminMfaSetupChallengeEnvelope: {
            data: components["schemas"]["AdminMfaSetupChallenge"];
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminMfaEnrollmentEnvelope: {
            data: components["schemas"]["AdminMfaEnrollment"];
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminMfaEnrollmentConfirmedEnvelope: {
            data: components["schemas"]["AdminMfaEnrollmentConfirmed"];
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminSessionRevokedEnvelope: {
            data: components["schemas"]["AdminSessionRevoked"];
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminAuthenticationChallengeEnvelope: {
            data: components["schemas"]["AdminMfaChallenge"] | components["schemas"]["AdminMfaSetupChallenge"];
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminSessionListEnvelope: {
            data: {
                items: components["schemas"]["AdminSessionView"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminUser: {
            /** Format: uuid */
            id: string;
            /** Format: email */
            email: string;
            displayName: string;
            /** @enum {string} */
            locale: "zh-CN" | "zh-HK" | "en";
            /** @enum {string} */
            status: "invited" | "active" | "suspended";
            roleIds: string[];
            mfaRequired: boolean;
            mfaEnabled: boolean;
            version: number;
            /** Format: date-time */
            lastLoginAt: string | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        AdminSessionData: {
            user: components["schemas"]["AdminUser"];
            permissionCodes: string[];
            mfaVerified: boolean;
            /** Format: date-time */
            idleExpiresAt: string;
            /** Format: date-time */
            absoluteExpiresAt: string;
            /** @description Session-bound CSRF token; never log or persist in analytics. */
            csrfToken: string;
        } & unknown;
        AdminMfaChallenge: {
            /** Format: uuid */
            challengeId: string;
            /** @constant */
            nextAction: "verify_mfa";
            allowedMethods: ("totp" | "recovery_code")[];
            /** Format: date-time */
            expiresAt: string;
        };
        PasswordResetAccepted: {
            /** @constant */
            requestAccepted: true;
        };
        AdminSessionsRevoked: {
            /** Format: uuid */
            userId: string;
            revokedCount: number;
            /** Format: date-time */
            revokedAt: string;
        };
        /** @description Append-only record. Application code never edits or deletes audit rows. */
        AdminAuditLog: {
            /** Format: uuid */
            id: string;
            /**
             * Format: uuid
             * @description Null for unauthenticated attempts such as a denied login.
             */
            actorId: string | null;
            action: string;
            objectId: string | null;
            result: string;
            requestId: string;
            reason: string | null;
            /** Format: date-time */
            occurredAt: string;
        };
        AdminAuditLogListEnvelope: {
            data: {
                items: components["schemas"]["AdminAuditLog"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminRole: {
            /** Format: uuid */
            id: string;
            name: string;
            /**
             * @description owner 为不可编辑的店主角色；admin/preset 为默认岗位权限包；custom 为自建角色。
             * @enum {string}
             */
            kind?: "owner" | "admin" | "preset" | "custom";
            /** @description 默认岗位权限包的稳定标识，角色改名后不变；自定义角色为 null。 */
            presetKey?: string | null;
            description: string | null;
            permissionCodes: string[];
            version: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        MarketProfile: {
            marketCode: string;
            enabled: boolean;
            eligibleProductIds: string[];
            /** @enum {string} */
            reviewStatus: "pending" | "approved" | "rejected" | "revoked" | "expired";
            /** Format: date-time */
            reviewValidUntil: string | null;
        } & unknown;
        StoreConfiguration: {
            displayName: string;
            locales: ("zh-CN" | "zh-HK" | "en")[];
            /** @enum {string} */
            defaultLocale: "zh-CN" | "zh-HK" | "en";
            baseCurrency: string;
            /** @description Valid IANA zone; server validates existence. */
            timezone: string;
            marketProfiles: components["schemas"]["MarketProfile"][];
            featureFlags: {
                [key: string]: boolean;
            };
            brandAssets: {
                /** Format: uuid */
                logoMediaId: string | null;
                /** Format: uuid */
                faviconMediaId: string | null;
            };
            version: number;
            /** Format: date-time */
            updatedAt: string;
        };
        AdminSessionEnvelope: {
            data: components["schemas"]["AdminSessionData"];
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminMfaChallengeEnvelope: {
            data: components["schemas"]["AdminMfaChallenge"];
            meta: components["schemas"]["ResponseMeta"];
        };
        PasswordResetAcceptedEnvelope: {
            data: components["schemas"]["PasswordResetAccepted"];
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminUserEnvelope: {
            data: components["schemas"]["AdminUser"];
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminSessionsRevokedEnvelope: {
            data: components["schemas"]["AdminSessionsRevoked"];
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminRoleEnvelope: {
            data: components["schemas"]["AdminRole"];
            meta: components["schemas"]["ResponseMeta"];
        };
        StoreConfigurationEnvelope: {
            data: components["schemas"]["StoreConfiguration"];
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminUserListEnvelope: {
            data: {
                items: components["schemas"]["AdminUser"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminRoleListEnvelope: {
            data: {
                items: components["schemas"]["AdminRole"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        ResponseMeta: {
            requestId: string;
            nextCursor?: string | null;
            hasMore?: boolean;
        };
        SuccessEnvelope: {
            /** @description Operation-specific data object. Each operation references the DTO described in API_SPEC.md. */
            data: {
                [key: string]: unknown;
            };
            meta: {
                requestId: string;
                nextCursor?: string | null;
                hasMore?: boolean;
            };
        };
        OtpChallengeEnvelope: {
            data: components["schemas"]["OtpChallenge"];
            meta: components["schemas"]["ResponseMeta"];
        };
        OtpChallenge: {
            /** Format: uuid */
            challengeId: string;
            /** @constant */
            challengeAccepted: true;
            resendAfterSeconds: number;
            expiresInSeconds: number;
        };
        ProductEnvelope: {
            data: components["schemas"]["AdminProduct"];
            meta: components["schemas"]["ResponseMeta"];
        };
        ProductListEnvelope: {
            data: {
                items: components["schemas"]["AdminProduct"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        PublicProductEnvelope: {
            data: components["schemas"]["PublicProduct"];
            meta: components["schemas"]["ResponseMeta"];
        };
        PublicProductListEnvelope: {
            data: {
                items: components["schemas"]["PublicProduct"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        ProductPublishEnvelope: {
            data: components["schemas"]["ProductPublicationResult"];
            meta: components["schemas"]["ResponseMeta"];
        };
        ImportJobEnvelope: {
            data: components["schemas"]["ImportJob"];
            meta: components["schemas"]["ResponseMeta"];
        };
        ImportPreviewEnvelope: {
            data: components["schemas"]["ImportPreview"];
            meta: components["schemas"]["ResponseMeta"];
        };
        CartEnvelope: {
            data: components["schemas"]["Cart"];
            meta: components["schemas"]["ResponseMeta"];
        };
        QuoteEnvelope: {
            data: components["schemas"]["CheckoutQuote"];
            meta: components["schemas"]["ResponseMeta"];
        };
        ShippingMethodsEnvelope: {
            data: components["schemas"]["ShippingMethodsData"];
            meta: components["schemas"]["ResponseMeta"];
        };
        ShippingMethodsData: {
            items: components["schemas"]["ShippingMethodPublic"][];
        };
        ShippingMethodPublic: {
            /**
             * Format: uuid
             * @description Shipping rate id to pass back as shippingMethodId in the quote request
             */
            id: string;
            code: string;
            name: string;
            /** @description Server-computed fee for the current cart subtotal (0 when above the free-shipping threshold) */
            feeMinor: number;
            estimatedMinDays: number | null;
            estimatedMaxDays: number | null;
            codEnabled: boolean;
        };
        OrderCreatedEnvelope: {
            data: components["schemas"]["CheckoutOrderCreated"];
            meta: components["schemas"]["ResponseMeta"];
        };
        OrderListEnvelope: {
            data: {
                items: components["schemas"]["OrderSummary"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        OrderDetailEnvelope: {
            data: components["schemas"]["AdminOrder"];
            meta: components["schemas"]["ResponseMeta"];
        };
        Category: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            parentId: string | null;
            position: number;
            enabled: boolean;
            translations: components["schemas"]["LabelTranslationInput"][];
            version: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        CategoryEnvelope: {
            data: components["schemas"]["Category"];
            meta: components["schemas"]["ResponseMeta"];
        };
        CategoryListEnvelope: {
            data: {
                items: components["schemas"]["Category"][];
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        Brand: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            logoMediaId: string | null;
            enabled: boolean;
            translations: components["schemas"]["LabelTranslationInput"][];
            version: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        BrandEnvelope: {
            data: components["schemas"]["Brand"];
            meta: components["schemas"]["ResponseMeta"];
        };
        BrandListEnvelope: {
            data: {
                items: components["schemas"]["Brand"][];
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        MediaAsset: {
            /** Format: uuid */
            id: string;
            objectKey: string;
            /** @enum {string} */
            contentType: "image/jpeg" | "image/png" | "image/webp";
            sizeBytes: number;
            sha256: string | null;
            width: number | null;
            height: number | null;
            originalFileName: string;
            /** @enum {string} */
            status: "pending" | "ready";
            url: string | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        MediaAssetEnvelope: {
            data: components["schemas"]["MediaAsset"];
            meta: components["schemas"]["ResponseMeta"];
        };
        MediaAssetListEnvelope: {
            data: {
                items: components["schemas"]["MediaAsset"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminProduct: {
            /** Format: uuid */
            id: string;
            baseSku: string | null;
            /** Format: uuid */
            brandId?: string | null;
            categoryIds?: string[];
            marketCodes?: string[];
            /** @enum {string} */
            status: "draft" | "active" | "archived";
            translations: components["schemas"]["ProductTranslationInput"][];
            variants: components["schemas"]["ProductVariantResponse"][];
            media?: components["schemas"]["ProductMediaInput"][];
            version: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        ProductVariantResponse: {
            sku: string;
            optionValues: {
                [key: string]: string;
            };
            priceMinor: number;
            compareAtMinor?: number | null;
            currency: string;
            /**
             * @default active
             * @enum {string}
             */
            status: "active" | "inactive";
            /** Format: uuid */
            id: string;
            readonly onHand?: number;
            readonly reserved?: number;
            readonly available?: number;
        };
        PublicProduct: {
            /** Format: uuid */
            id: string;
            slug: string;
            name: string;
            shortDescription?: string | null;
            description?: string | null;
            seoTitle?: string | null;
            seoDescription?: string | null;
            variants: components["schemas"]["PublicProductVariant"][];
            media: components["schemas"]["ProductMediaInput"][];
            inStock: boolean;
            /** @enum {string} */
            displayStockState?: "available" | "sold_out" | "hidden";
        };
        PublicProductVariant: {
            /** Format: uuid */
            id: string;
            sku: string;
            optionValues: {
                [key: string]: string;
            };
            priceMinor: number;
            compareAtMinor?: number | null;
            currency: string;
            available: number;
        };
        ProductPublicationResult: {
            /** Format: uuid */
            productId: string;
            version: number;
            /** @enum {string} */
            status: "active" | "scheduled" | "failed";
            /** Format: date-time */
            publishedAt: string | null;
            /** Format: uuid */
            jobId?: string | null;
        };
        ImportJob: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            status: "uploaded" | "validating" | "ready" | "processing" | "completed" | "completed_with_errors" | "failed" | "cancelled";
            /** @enum {string} */
            mode: "create_or_update_by_sku" | "create_only" | "update_only";
            /** @enum {string} */
            commitMode: "valid_rows" | "atomic";
            totalRows: number;
            validRows: number;
            invalidRows: number;
            createdCount?: number;
            updatedCount?: number;
            skippedCount?: number;
            failedCount?: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            completedAt?: string | null;
        };
        ImportPreview: {
            /** Format: uuid */
            jobId: string;
            fileSha256: string;
            mappingVersion: number;
            totalRows: number;
            validRows: number;
            invalidRows: number;
            newCount?: number;
            updateCount?: number;
            skipCount?: number;
            previewRows: {
                rowNumber: number;
                sku?: string | null;
                /** @enum {string} */
                action: "create" | "update" | "skip" | "reject";
                changes?: {
                    [key: string]: unknown;
                }[];
                errors: components["schemas"]["FieldError"][];
                warnings: string[];
            }[];
        };
        MoneyBreakdown: {
            currency: string;
            subtotalMinor: number;
            discountMinor: number;
            shippingMinor: number;
            taxMinor: number;
            totalMinor: number;
        };
        /** @description Guest cart. Prices and availability are recomputed on every read; the client never supplies them. */
        Cart: {
            /** Format: uuid */
            cartId: string;
            currency: string;
            locale: string | null;
            itemCount: number;
            /** @description Sum of currently sellable lines only. */
            subtotalMinor: number;
            items: components["schemas"]["CartLine"][];
            warnings: string[];
            /** Format: date-time */
            expiresAt: string;
        };
        CartLine: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            variantId: string;
            sku: string;
            productName: string;
            variantName: string | null;
            quantity: number;
            unitPriceMinor: number;
            lineSubtotalMinor: number;
            /** @description False when the variant is no longer sellable or stock fell below the line quantity. */
            available: boolean;
            availableQuantity: number;
        };
        CheckoutQuote: {
            currency: string;
            subtotalMinor: number;
            discountMinor: number;
            shippingMinor: number;
            taxMinor: number;
            totalMinor: number;
            /** Format: uuid */
            quoteId: string;
            /** @description Immutable quote revision echoed as confirmedQuoteVersion when ordering. */
            version: number;
            /** Format: date-time */
            expiresAt: string;
            lines: components["schemas"]["QuoteLine"][];
            shippingMethod: {
                code: string;
                name: string;
                estimatedMinDays?: number | null;
                estimatedMaxDays?: number | null;
            };
            couponSummary: {
                codeMasked?: string;
                discountMinor?: number;
            } | null;
            ruleVersions: {
                price: string;
                promotion: string;
                shipping: string;
                tax: string | null;
            };
            warnings: string[];
        };
        QuoteLine: {
            productName?: string;
            variantName?: string | null;
            /** Format: uuid */
            variantId: string;
            sku: string;
            quantity: number;
            unitPriceMinor: number;
            lineSubtotalMinor: number;
            lineDiscountMinor: number;
            lineTotalMinor: number;
        };
        CheckoutOrderCreated: {
            /** Format: uuid */
            orderId: string;
            publicOrderNumber: string;
            /** @enum {string} */
            orderStatus: "pending_payment" | "awaiting_confirmation";
            /** @enum {string} */
            paymentStatus: "created" | "requires_action" | "processing" | "unknown" | "cod_due";
            currency: string;
            totalMinor: number;
            paymentAction: components["schemas"]["PaymentAction"];
        };
        PaymentAction: {
            /** @enum {string} */
            type: "none" | "redirect" | "instructions";
            /** Format: uri */
            redirectUrl?: string | null;
            instructions?: string | null;
        };
        OrderSummary: {
            /** Format: uuid */
            id: string;
            publicOrderNumber: string;
            orderStatus: string;
            paymentStatus: string;
            currency: string;
            totalMinor: number;
            contactMasked?: string | null;
            /** Format: date-time */
            createdAt: string;
        };
        AdminOrder: {
            /** Format: uuid */
            id: string;
            publicOrderNumber: string;
            /** @enum {string} */
            orderStatus: "pending_payment" | "awaiting_confirmation" | "confirmed" | "processing" | "partially_shipped" | "shipped" | "completed" | "cancelled" | "on_hold";
            /** @enum {string} */
            paymentStatus: "created" | "requires_action" | "processing" | "succeeded" | "failed" | "cancelled" | "unknown" | "cod_due" | "collected" | "rejected" | "returned";
            /** @enum {string} */
            fulfillmentStatus: "unfulfilled" | "preparing" | "partially_fulfilled" | "fulfilled" | "delivered" | "exception";
            currency: string;
            subtotalMinor?: number;
            discountMinor?: number;
            shippingMinor?: number;
            taxMinor?: number;
            totalMinor: number;
            /** @description Current optimistic-concurrency version for order actions. */
            version: number;
            locale?: string;
            marketCode?: string;
            paymentMethodCode?: string;
            customerNote?: string | null;
            /** Format: date-time */
            placedAt?: string;
            lines: {
                [key: string]: unknown;
            }[];
            addressSnapshot?: {
                [key: string]: unknown;
            } | null;
            /** @description Contact fields are masked unless customers.read_pii is granted. */
            contact?: {
                [key: string]: unknown;
            };
            shippingMethod?: {
                [key: string]: unknown;
            };
            cancellation?: {
                [key: string]: unknown;
            } | null;
            shipments: {
                [key: string]: unknown;
            }[];
            statusHistory: {
                [key: string]: unknown;
            }[];
            notes?: {
                [key: string]: unknown;
            }[];
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        ErrorEnvelope: {
            error: {
                code: string;
                message: string;
                fieldErrors?: components["schemas"]["FieldError"][];
                requestId: string;
                currentVersion?: number | null;
            };
        };
        FieldError: {
            field: string;
            locale?: string | null;
            code: string;
            message: string;
        };
        AdminLoginRequest: {
            /** Format: email */
            email: string;
            password: string;
        };
        MfaVerifyRequest: {
            /** Format: uuid */
            challengeId: string;
            code: string;
        };
        PasswordResetRequest: {
            /** Format: email */
            email: string;
        };
        PasswordResetCompleteRequest: {
            resetToken: string;
            newPassword: string;
        };
        AdminUserInviteRequest: {
            /** Format: email */
            email: string;
            displayName: string;
            roleIds: string[];
            /** @enum {string} */
            locale: "zh-CN" | "zh-HK" | "en";
        };
        AdminUserPatchRequest: {
            displayName?: string;
            /** @enum {string} */
            status?: "active" | "suspended";
            roleIds?: string[];
        };
        RoleWriteRequest: {
            name: string;
            description?: string | null;
            permissionCodes: string[];
        };
        RolePatchRequest: {
            name?: string;
            description?: string | null;
            permissionCodes?: string[];
        };
        StoreConfigPatchRequest: {
            displayName?: string;
            locales?: ("zh-CN" | "zh-HK" | "en")[];
            /** @enum {string} */
            defaultLocale?: "zh-CN" | "zh-HK" | "en";
            baseCurrency?: string;
            /** @description IANA time zone identifier */
            timezone?: string;
            marketProfiles?: components["schemas"]["MarketProfileInput"][];
            featureFlags?: {
                [key: string]: boolean;
            };
            brandAssets?: {
                /** Format: uuid */
                logoMediaId?: string | null;
                /** Format: uuid */
                faviconMediaId?: string | null;
            };
        };
        MarketProfileInput: {
            marketCode: string;
            enabled: boolean;
            eligibleProductIds?: string[];
        };
        ProductFields: {
            baseSku?: string | null;
            /** Format: uuid */
            brandId?: string | null;
            categoryIds?: string[];
            marketCodes?: string[];
            translations?: components["schemas"]["ProductTranslationInput"][];
            variants?: components["schemas"]["ProductVariantInput"][];
            media?: components["schemas"]["ProductMediaInput"][];
            attributes?: components["schemas"]["AttributeValueInput"][];
            taxClassRef?: string | null;
        };
        ProductWriteRequest: components["schemas"]["ProductFields"] & Record<string, never>;
        /** @description Partial update; omitted fields are unchanged. Product status and stock quantities are not writable here. */
        ProductPatchRequest: components["schemas"]["ProductFields"];
        ProductTranslationInput: {
            /** @enum {string} */
            locale: "zh-CN" | "zh-HK" | "en";
            name: string;
            slug: string;
            shortDescription?: string | null;
            description?: string | null;
            seoTitle?: string | null;
            seoDescription?: string | null;
        };
        ProductVariantInput: {
            sku: string;
            optionValues: {
                [key: string]: string;
            };
            priceMinor: number;
            compareAtMinor?: number | null;
            currency: string;
            /**
             * @default active
             * @enum {string}
             */
            status: "active" | "inactive";
        };
        ProductMediaInput: {
            /** Format: uuid */
            mediaId: string;
            position: number;
            altByLocale?: {
                [key: string]: string;
            };
        };
        AttributeValueInput: {
            attributeCode: string;
            value: string | number | boolean;
        };
        ProductPublishRequest: {
            expectedVersion: number;
            marketCodes: string[];
            /**
             * Format: date-time
             * @description Null or omitted means publish now; future UTC instant schedules publication.
             */
            publishedAt?: string | null;
        };
        CategoryFields: {
            /** Format: uuid */
            parentId?: string | null;
            position?: number;
            /** @default true */
            enabled: boolean;
            translations?: components["schemas"]["LabelTranslationInput"][];
        };
        CategoryWriteRequest: components["schemas"]["CategoryFields"] & Record<string, never>;
        CategoryPatchRequest: components["schemas"]["CategoryFields"];
        BrandFields: {
            /** Format: uuid */
            logoMediaId?: string | null;
            /** @default true */
            enabled: boolean;
            translations?: components["schemas"]["LabelTranslationInput"][];
        };
        BrandWriteRequest: components["schemas"]["BrandFields"] & Record<string, never>;
        BrandPatchRequest: components["schemas"]["BrandFields"];
        LabelTranslationInput: {
            /** @enum {string} */
            locale: "zh-CN" | "zh-HK" | "en";
            name: string;
            slug?: string | null;
            description?: string | null;
        };
        MediaUploadTargetRequest: {
            fileName: string;
            /** @enum {string} */
            contentType: "image/jpeg" | "image/png" | "image/webp";
            sizeBytes: number;
        };
        MediaUploadCompleteRequest: {
            objectKey: string;
            sha256: string;
        };
        PageFields: {
            pageKey?: string;
            pageType?: string;
            translations?: components["schemas"]["PageTranslationInput"][];
            blocks?: components["schemas"]["ContentBlockInput"][];
        };
        PageWriteRequest: components["schemas"]["PageFields"] & Record<string, never>;
        /** @description Partial update; omitted fields are unchanged. */
        PagePatchRequest: components["schemas"]["PageFields"];
        PageTranslationInput: {
            /** @enum {string} */
            locale: "zh-CN" | "zh-HK" | "en";
            title: string;
            slug: string;
            seoTitle?: string | null;
            seoDescription?: string | null;
            /** @default false */
            indexable: boolean;
        };
        ContentBlockInput: {
            id: string;
            /** @description Must be registered by this instance's storefront theme. */
            type: string;
            visible: boolean;
            position: number;
            /** @description Validated against the registered schema for block type. */
            config: {
                [key: string]: unknown;
            };
        };
        PreviewRequest: {
            /** @enum {string} */
            locale: "zh-CN" | "zh-HK" | "en";
            /** @enum {string} */
            viewport: "mobile" | "desktop";
            expectedVersion: number;
        };
        PagePublishRequest: {
            expectedVersion: number;
            /**
             * @default immediate
             * @enum {string}
             */
            mode: "immediate" | "scheduled";
            /** Format: date-time */
            scheduledAt?: string | null;
        };
        PageRollbackRequest: {
            sourceVersion: number;
            reason: string;
            expectedVersion: number;
        };
        MerchandisingWriteRequest: {
            expectedVersion: number;
            sections: components["schemas"]["MerchandisingSectionInput"][];
        };
        MerchandisingSectionInput: {
            sectionId: string;
            type: string;
            visible: boolean;
            position: number;
            titleByLocale?: {
                [key: string]: string;
            };
            /** @enum {string} */
            sortMode: "manual" | "newest" | "fulfilled_sales_30d" | "price_asc" | "price_desc";
            limit: number;
            productIds?: string[];
            categoryIds?: string[];
            /** Format: uuid */
            collectionId?: string | null;
        };
        ImportCreateRequest: {
            fileObjectKey: string;
            fileSha256: string;
            /** @enum {string} */
            format: "csv" | "xlsx";
            /** @enum {string} */
            mode: "create_or_update_by_sku" | "create_only" | "update_only";
            /** @enum {string} */
            commitMode: "valid_rows" | "atomic";
            columnMapping: {
                [key: string]: string;
            };
            localeSet: ("zh-CN" | "zh-HK" | "en")[];
        };
        ImportExecuteRequest: {
            confirmedFileSha256: string;
            confirmedMappingVersion: number;
            expectedValidRows: number;
        };
        ExportCreateRequest: {
            /** @enum {string} */
            resource: "products" | "orders" | "customers" | "inventory" | "payments" | "settlements";
            filters?: {
                [key: string]: unknown;
            };
            columns: string[];
            /** @enum {string|null} */
            locale?: "zh-CN" | "zh-HK" | "en" | null;
            redactionPolicyVersion: string;
        };
        CartItemWriteRequest: {
            /** Format: uuid */
            variantId: string;
            quantity: number;
        };
        CartItemUpdateRequest: {
            quantity: number;
        };
        CheckoutQuoteRequest: {
            /** Format: uuid */
            cartId: string;
            /** @enum {string} */
            locale: "zh-CN" | "zh-HK" | "en";
            marketCode: string;
            contact: components["schemas"]["ContactInput"];
            shippingAddress?: components["schemas"]["AddressInput"];
            /** Format: uuid */
            shippingMethodId: string;
            couponCode?: string | null;
            policyAcceptances: components["schemas"]["PolicyAcceptanceInput"][];
        };
        ContactInput: {
            /** Format: email */
            email?: string | null;
            phone?: string | null;
            fullName?: string;
        } | {
            email: string;
        } | {
            phone: string;
        };
        AddressInput: {
            recipientName?: string;
            phone?: string | null;
            /** @description Case-insensitive on input; the server trims and uppercases it before validation. */
            countryCode: string;
            regionCode?: string | null;
            city?: string | null;
            district?: string | null;
            addressLine1: string;
            addressLine2?: string | null;
            postalCode?: string | null;
        };
        PolicyAcceptanceInput: {
            policyKey: string;
            version: string;
            /** @constant */
            accepted: true;
        };
        CheckoutOrderRequest: {
            /** Format: uuid */
            quoteId: string;
            confirmedQuoteVersion: number;
            paymentMethodCode: string;
            customerNote?: string | null;
        };
        OtpRequest: {
            /** Format: email */
            email: string;
            /** @enum {string} */
            locale: "zh-CN" | "zh-HK" | "en";
            /** @constant */
            purpose: "member_login";
        };
        OtpVerifyRequest: {
            /** Format: uuid */
            challengeId: string;
            code: string;
        };
        ReasonRequest: {
            reasonCode?: string | null;
            reason: string;
        };
        /** @description Paid orders must use after-sales refund flow. */
        OrderCancelRequest: {
            reasonCode?: string | null;
            reason: string;
            expectedVersion: number;
            /** @default false */
            customerNotified: boolean;
        };
        OrderAddressChangeRequest: {
            expectedVersion: number;
            address: components["schemas"]["AddressInput"];
            customerConfirmationRef?: string | null;
        };
        OrderNoteRequest: {
            note: string;
        };
        ShipmentLineInput: {
            /** Format: uuid */
            orderItemId: string;
            quantity: number;
        };
        ShipmentCreateRequest: {
            items: components["schemas"]["ShipmentLineInput"][];
            carrierCode?: string | null;
            carrierName?: string | null;
            trackingNumber?: string | null;
            note?: string | null;
        };
        ShipmentDispatchRequest: {
            /** Format: date-time */
            dispatchedAt: string;
            trackingNumber?: string | null;
            evidenceRef?: string | null;
        };
        ShipmentDeliverRequest: {
            /** Format: date-time */
            deliveredAt: string;
            evidenceRef?: string | null;
            note?: string | null;
        };
        PaymentMethodPatchRequest: {
            providerCode: string;
            /** @enum {string} */
            environment: "sandbox" | "production";
            enabled: boolean;
            publicConfig?: {
                [key: string]: unknown;
            };
            secretRef?: string | null;
            approvalReference?: string | null;
        };
        /**
         * @description Ledger state. Unknown means the provider has not answered yet and must stay unknown until a server-side query or webhook resolves it; it can never be forced to failed here.
         * @enum {string}
         */
        PaymentStatus: "pending" | "authorized" | "succeeded" | "failed" | "cancelled" | "unknown" | "collected" | "rejected" | "returned";
        AdminPaymentMethod: {
            /** Format: uuid */
            id: string;
            providerCode: string;
            /** @enum {string} */
            environment: "sandbox" | "production";
            displayName: string;
            enabled: boolean;
            /** @enum {string} */
            approvalStatus: "approved" | "unapproved";
            approvalReference?: string | null;
            /** Format: date-time */
            approvedAt?: string | null;
            publicConfig: {
                [key: string]: string;
            };
            /** @description Whether a credential reference is stored; the reference itself is never returned. */
            secretConfigured: boolean;
            secretFingerprint?: string | null;
            /** @enum {string} */
            connectionStatus: "unverified" | "ok" | "failed";
            /** Format: date-time */
            lastCheckedAt?: string | null;
            version: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        AdminPayment: {
            /** Format: uuid */
            id: string;
            publicPaymentNumber: string;
            /** Format: uuid */
            orderId: string;
            publicOrderNumber: string;
            providerCode: string;
            /** @enum {string} */
            environment: "sandbox" | "production";
            /** @enum {string} */
            channel: "cod" | "manual" | "online";
            status: components["schemas"]["PaymentStatus"];
            amountMinor: number;
            currency: string;
            providerTransactionId?: string | null;
            /** Format: date-time */
            paidAt?: string | null;
            /** Format: date-time */
            returnedAt?: string | null;
            reference?: string | null;
            failureCode?: string | null;
            failureMessage?: string | null;
            /** Format: uuid */
            recordedBy?: string | null;
            version: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
            events?: {
                /** Format: uuid */
                id: string;
                /** @enum {string} */
                type: "created" | "collected" | "rejected" | "returned" | "succeeded" | "cancelled" | "failed";
                fromStatus?: string | null;
                toStatus: components["schemas"]["PaymentStatus"];
                /** @enum {string} */
                source: "admin" | "system" | "provider";
                /** Format: uuid */
                actorId?: string | null;
                /** Format: date-time */
                occurredAt: string;
            }[];
        };
        PaymentMethodEnvelope: {
            data: components["schemas"]["AdminPaymentMethod"];
            meta: components["schemas"]["ResponseMeta"];
        };
        PaymentMethodListEnvelope: {
            data: {
                items: components["schemas"]["AdminPaymentMethod"][];
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        PaymentEnvelope: {
            data: components["schemas"]["AdminPayment"];
            meta: components["schemas"]["ResponseMeta"];
        };
        PaymentListEnvelope: {
            data: {
                items: components["schemas"]["AdminPayment"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        OrderPaymentResultRequest: {
            /**
             * @description collected = cash or transfer received; rejected = customer refused on delivery; returned = money handed back to the customer outside this system.
             * @enum {string}
             */
            outcome: "collected" | "succeeded" | "rejected" | "cancelled" | "returned";
            /** @description Must equal the order total in the order currency. */
            amountMinor: number;
            /** Format: date-time */
            occurredAt: string;
            reference?: string | null;
            /** @description Required for rejected and returned outcomes. */
            reason?: string | null;
            /** @description Order version the operator saw; stale writes are rejected. */
            expectedVersion: number;
        };
        PaymentResultEnvelope: {
            data: {
                /** Format: uuid */
                orderId: string;
                /** @enum {string} */
                orderPaymentStatus: "created" | "requires_action" | "processing" | "succeeded" | "failed" | "cancelled" | "unknown" | "cod_due" | "collected" | "rejected" | "returned";
                orderVersion: number;
                payment: components["schemas"]["AdminPayment"];
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        RefundCreateRequest: {
            /** Format: uuid */
            paymentId: string;
            /** Format: uuid */
            orderId: string;
            amountMinor: number;
            currency: string;
            reasonCode?: string | null;
            reason: string;
            /** Format: uuid */
            caseId?: string | null;
        };
        SettlementImportRequest: {
            providerCode: string;
            fileObjectKey: string;
            fileSha256: string;
            /** Format: date-time */
            periodStart: string;
            /** Format: date-time */
            periodEnd: string;
        };
        SettlementConfirmRequest: {
            previewVersion: number;
            reason: string;
        };
        SettlementResolveRequest: {
            resolutionCode: string;
            /** Format: uuid */
            internalRecordId?: string | null;
            reason: string;
        };
        ShippingZoneFields: {
            code?: string;
            nameByLocale?: {
                [key: string]: string;
            };
            countryCodes?: string[];
            regionCodes?: string[];
            priority?: number;
            enabled?: boolean;
        };
        ShippingZoneWriteRequest: components["schemas"]["ShippingZoneFields"] & Record<string, never>;
        ShippingZonePatchRequest: components["schemas"]["ShippingZoneFields"];
        ShippingRateFields: {
            code?: string;
            nameByLocale?: {
                [key: string]: string;
            };
            zoneIds?: string[];
            fixedFeeMinor?: number;
            freeAboveMinor?: number | null;
            currency?: string;
            estimatedMinDays?: number | null;
            estimatedMaxDays?: number | null;
            /** @default false */
            codEnabled: boolean;
            enabled?: boolean;
        };
        ShippingRateWriteRequest: components["schemas"]["ShippingRateFields"] & Record<string, never>;
        ShippingRatePatchRequest: components["schemas"]["ShippingRateFields"];
        ShippingQuotePreviewRequest: {
            address: components["schemas"]["AddressInput"];
            merchandiseSubtotalMinor: number;
            currency: string;
        };
        CustomerWriteRequest: {
            displayName?: string;
            /** Format: email */
            email?: string | null;
            phone?: string | null;
            tags?: string[];
            internalNote?: string | null;
        };
        MemberWriteRequest: {
            /** Format: uuid */
            customerId: string;
            consentRef: string;
            /** Format: uuid */
            tierId?: string | null;
        };
        MemberPatchRequest: {
            /** @enum {string} */
            status?: "active" | "suspended" | "closed";
            /** Format: uuid */
            tierId?: string | null;
            reason: string;
        };
        PointsAdjustmentRequest: {
            deltaPoints: number;
            reasonCode: string;
            reason: string;
        };
        LoyaltySetting: {
            enabled: boolean;
            minorPerPoint: number;
            pointsExpiryMonths: number | null;
            version: number;
            /** Format: date-time */
            updatedAt: string;
        };
        LoyaltySettingPatchRequest: {
            enabled?: boolean;
            minorPerPoint?: number;
            pointsExpiryMonths?: number | null;
        };
        MembershipTierFields: {
            code?: string;
            nameByLocale?: {
                [key: string]: string;
            };
            rank?: number;
            minLifetimeSpendMinor?: number;
            minorPerPoint?: number | null;
            benefits?: string[];
            /** @enum {string} */
            status?: "active" | "retired";
        };
        MembershipTierWriteRequest: components["schemas"]["MembershipTierFields"] & Record<string, never>;
        MembershipTierPatchRequest: components["schemas"]["MembershipTierFields"];
        MembershipTier: {
            /** Format: uuid */
            id: string;
            code: string;
            nameByLocale: {
                [key: string]: string;
            };
            rank: number;
            minLifetimeSpendMinor: number;
            minorPerPoint: number | null;
            benefits: string[];
            /** @enum {string} */
            status: "active" | "retired";
            version: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        PrivacyRequestCreate: {
            /** @enum {string} */
            requestType: "access" | "export" | "correct" | "withdraw_marketing" | "delete" | "anonymize";
            customerRef?: string | null;
            /** @enum {string} */
            sourceChannel: "email" | "phone" | "admin" | "storefront";
            scope: string[];
        };
        PrivacyVerifyRequest: {
            verificationMethod: string;
            evidenceRef: string;
            reason: string;
        };
        PrivacyCompleteRequest: {
            /** @enum {string} */
            decision: "approved" | "rejected" | "needs_information" | "completed";
            reason: string;
            retentionExceptionRef?: string | null;
            /** Format: uuid */
            exportJobId?: string | null;
        };
        /** @description usedCount = reserved + redeemed - returned. Only reserved and redeemed consume quota. */
        CouponUsage: {
            reservedCount: number;
            redeemedCount: number;
            releasedCount: number;
            expiredCount: number;
            returnedCount: number;
            usedCount: number;
        };
        AdminCoupon: {
            /** Format: uuid */
            id: string;
            code: string;
            /** @description Safe to show in logs and storefront responses. */
            codeMasked: string;
            /** @enum {string} */
            status: "active" | "disabled";
            /** @enum {string} */
            discountType: "fixed" | "percent";
            discountValue: number;
            currency: string;
            /** Format: date-time */
            validFrom: string;
            /** Format: date-time */
            validUntil: string;
            minSubtotalMinor: number | null;
            totalLimit: number | null;
            perCustomerLimit: number | null;
            eligibleProductIds: string[];
            eligibleCategoryIds: string[];
            memberTierIds: string[];
            /** @enum {string} */
            refundPolicy: "none" | "restore";
            version: number;
            /** Format: uuid */
            createdBy: string | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
            usage: components["schemas"]["CouponUsage"];
        };
        CouponEnvelope: {
            data: components["schemas"]["AdminCoupon"];
            meta: components["schemas"]["ResponseMeta"];
        };
        CouponListEnvelope: {
            data: {
                items: components["schemas"]["AdminCoupon"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminCouponRedemption: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            orderId: string;
            publicOrderNumber: string;
            /** @enum {string} */
            status: "reserved" | "redeemed" | "released" | "expired";
            discountMinor: number;
            currency: string;
            /** @description First 8 hex characters of the instance-key HMAC. Opaque, not reversible, no contact data. */
            customerRef: string | null;
            /** Format: date-time */
            reservedAt: string;
            /** Format: date-time */
            redeemedAt: string | null;
            /** Format: date-time */
            releasedAt: string | null;
            /** Format: date-time */
            expiresAt: string | null;
            ruleVersion: number | null;
        };
        CouponRedemptionListEnvelope: {
            data: {
                items: components["schemas"]["AdminCouponRedemption"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        CouponFields: {
            /** @description Surrounding whitespace is trimmed and letters are uppercased before storage. */
            code?: string;
            /** @enum {string} */
            discountType?: "fixed" | "percent";
            /** @description Fixed uses currency minor units; percent uses basis points */
            discountValue?: number;
            /** Format: date-time */
            validFrom?: string;
            /** Format: date-time */
            validUntil?: string;
            minSubtotalMinor?: number | null;
            totalLimit?: number | null;
            perCustomerLimit?: number | null;
            eligibleProductIds?: string[];
            eligibleCategoryIds?: string[];
            /** @description Member-tier restriction. Rejected while no member directory exists (M10). */
            memberTierIds?: string[];
            /**
             * @description restore returns the coupon quota through a new return record once the order is fully refunded; it never rewrites the original usage row.
             * @default none
             * @enum {string}
             */
            refundPolicy: "none" | "restore";
            /**
             * @default active
             * @enum {string}
             */
            status: "active" | "disabled";
        } & unknown;
        CouponWriteRequest: components["schemas"]["CouponFields"] & Record<string, never>;
        /** @description Partial update; discountType and discountValue are validated together. */
        CouponPatchRequest: components["schemas"]["CouponFields"];
        CouponBatchRequest: {
            /** Format: uuid */
            couponId: string;
            recipientMemberIds?: string[];
            recipientFilter?: {
                [key: string]: unknown;
            };
            /** @enum {string} */
            channel: "account_only" | "email" | "sms";
            /** Format: uuid */
            templateId?: string | null;
        };
        CouponBatchIssueRequest: {
            confirmedRecipientCount: number;
        };
        InventoryAdjustmentRequest: {
            /** Format: uuid */
            variantId: string;
            /** @description Signed change. Negative values remove stock but never below reserved. */
            delta: number;
            reasonCode?: string | null;
            reason: string;
            reference?: string | null;
            /** @description Inventory version the operator saw; 0 means the SKU has no stock row yet. */
            expectedVersion: number;
        };
        InventoryThresholdsPatchRequest: {
            /** Format: uuid */
            variantId: string;
            lowStockLevel: number;
            /** @description 0 creates the threshold; otherwise it must equal the version that was read. */
            expectedVersion: number;
        };
        /** @enum {string} */
        InventoryMovementType: "return_restock" | "return_damaged" | "return_quarantine" | "return_scrap" | "adjustment";
        /** @enum {string} */
        InventoryLowStockState: "ok" | "low" | "out_of_stock";
        AdminInventoryItem: {
            /** Format: uuid */
            variantId: string;
            sku: string;
            /** Format: uuid */
            productId: string;
            productName: string;
            productStatus: string;
            variantStatus: string;
            onHand: number;
            reserved: number;
            available: number;
            lowStockLevel: number;
            /** @description Version of the threshold row; 0 means no threshold was ever set. */
            lowStockVersion: number;
            lowStockState: components["schemas"]["InventoryLowStockState"];
            version: number;
            /** Format: date-time */
            updatedAt: string;
        };
        AdminStockMovement: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            variantId: string;
            type: components["schemas"]["InventoryMovementType"];
            quantity: number;
            stockDelta: number;
            onHandAfter: number | null;
            reason: string;
            reasonCode?: string | null;
            reference?: string | null;
            /** Format: uuid */
            orderId?: string | null;
            /** Format: uuid */
            caseId?: string | null;
            /** Format: uuid */
            actorId?: string | null;
            /** Format: date-time */
            createdAt: string;
        };
        AdminInventoryThreshold: {
            /** Format: uuid */
            variantId: string;
            lowStockLevel: number;
            version: number;
            /** Format: uuid */
            updatedBy?: string | null;
            /** Format: date-time */
            updatedAt: string;
        };
        InventoryListEnvelope: {
            data: {
                items: components["schemas"]["AdminInventoryItem"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        InventoryMovementListEnvelope: {
            data: {
                items: components["schemas"]["AdminStockMovement"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        InventoryThresholdListEnvelope: {
            data: {
                items: components["schemas"]["AdminInventoryThreshold"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        InventoryAdjustmentEnvelope: {
            data: {
                movement: components["schemas"]["AdminStockMovement"];
                /** Format: uuid */
                variantId: string;
                onHand: number;
                reserved: number;
                available: number;
                version: number;
                lowStockLevel: number;
                /** @description True when the same Idempotency-Key returned the original movement. */
                replay: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        InventoryThresholdEnvelope: {
            data: components["schemas"]["AdminInventoryThreshold"];
            meta: components["schemas"]["ResponseMeta"];
        };
        NotificationSettingsPatchRequest: {
            channels?: components["schemas"]["NotificationChannelInput"][];
            templates?: components["schemas"]["NotificationTemplateInput"][];
        };
        NotificationChannelInput: {
            /** @enum {string} */
            channel: "email" | "sms" | "whatsapp";
            enabled: boolean;
            credentialRef?: string | null;
        };
        NotificationTemplateInput: {
            eventType: string;
            /** @enum {string} */
            purpose: "transactional" | "marketing";
            /** @enum {string} */
            locale: "zh-CN" | "zh-HK" | "en";
            /** @enum {string} */
            channel: "email" | "sms" | "whatsapp";
            subject: string | null;
            body: string;
            enabled: boolean;
        };
        ReportExportRequest: {
            reportKey: string;
            /** Format: date-time */
            from: string;
            /** Format: date-time */
            to: string;
            /** @description IANA time zone identifier */
            timezone: string;
            /** @enum {string} */
            format: "csv" | "xlsx";
            filters?: {
                [key: string]: unknown;
            };
            /** @default false */
            includePii: boolean;
        };
        BackupRequest: {
            includeMedia: boolean;
            reason: string;
        };
        AfterSalesCreateRequest: {
            /** Format: uuid */
            orderId: string;
            /** @enum {string} */
            caseType: "cancel" | "refund" | "return" | "exchange";
            items: {
                /** Format: uuid */
                orderItemId: string;
                quantity: number;
            }[];
            reasonCode?: string | null;
            reason: string;
            requestedRefundMinor?: number | null;
        };
        ReturnReceiptRequest: {
            /** Format: date-time */
            receivedAt: string;
            reference?: string | null;
            items: {
                /** Format: uuid */
                orderItemId: string;
                quantity: number;
            }[];
        };
        ReturnInspectionRequest: {
            reason: string;
            items: {
                /** Format: uuid */
                orderItemId: string;
                quantity: number;
                /** @enum {string} */
                disposition: "sellable" | "damaged" | "quarantine" | "scrap";
                note?: string | null;
            }[];
        };
        AfterSalesRefundRequest: {
            amountMinor: number;
            currency: string;
            reasonCode?: string | null;
            reason: string;
        };
        /** @enum {string} */
        AfterSalesCaseType: "cancel" | "refund" | "return" | "exchange";
        /**
         * @description Cases only move forward. A cancellation case closes as soon as the order is cancelled because there is nothing left to fulfil; refunds, returns and exchanges keep their own timeline.
         * @enum {string}
         */
        AfterSalesCaseStatus: "submitted" | "under_review" | "approved" | "rejected" | "needs_information" | "return_in_transit" | "received_inspection" | "refund_pending" | "refunded" | "replacement_sent" | "completed" | "closed";
        /**
         * @description Unknown means the provider has not answered yet; it can only be resolved by a provider query or webhook, never by an operator forcing a state.
         * @enum {string}
         */
        RefundStatus: "requested" | "approved" | "processing" | "refunded" | "failed" | "rejected" | "cancelled" | "unknown";
        ReturnShipmentRequest: {
            carrierCode?: string | null;
            carrierName?: string | null;
            trackingNumber: string;
            /** Format: date-time */
            shippedAt?: string | null;
            reference?: string | null;
            note?: string | null;
        };
        RefundExecuteRequest: {
            reason: string;
            /** @description Payout proof for offline channels (bank slip, cash receipt); required for them. */
            reference?: string | null;
            /** Format: date-time */
            occurredAt?: string | null;
        };
        AdminRefund: {
            /** Format: uuid */
            id: string;
            publicRefundNumber: string;
            /** Format: uuid */
            orderId: string;
            publicOrderNumber: string;
            /** Format: uuid */
            paymentId: string;
            publicPaymentNumber: string;
            /** Format: uuid */
            caseId?: string | null;
            /** @enum {string} */
            channel: "cod" | "manual" | "online";
            providerCode: string;
            /** @enum {string} */
            environment: "sandbox" | "production";
            amountMinor: number;
            currency: string;
            status: components["schemas"]["RefundStatus"];
            reasonCode?: string | null;
            reason: string;
            /** Format: uuid */
            requestedBy: string;
            /** Format: uuid */
            approvedBy?: string | null;
            /** Format: uuid */
            executedBy?: string | null;
            /** Format: date-time */
            approvedAt?: string | null;
            /** Format: date-time */
            executedAt?: string | null;
            reference?: string | null;
            externalRefundId?: string | null;
            failureCode?: string | null;
            failureMessage?: string | null;
            version: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
            events?: {
                /** Format: uuid */
                id: string;
                /** @enum {string} */
                type: "requested" | "approved" | "rejected" | "executed" | "failed" | "cancelled" | "unknown";
                fromStatus?: string | null;
                toStatus: components["schemas"]["RefundStatus"];
                /** @enum {string} */
                source: "admin" | "system" | "provider";
                /** Format: uuid */
                actorId?: string | null;
                /** Format: date-time */
                occurredAt: string;
            }[];
        };
        RefundEnvelope: {
            data: components["schemas"]["AdminRefund"];
            meta: components["schemas"]["ResponseMeta"];
        };
        RefundListEnvelope: {
            data: {
                items: components["schemas"]["AdminRefund"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
        AdminAfterSalesItem: {
            /** Format: uuid */
            orderItemId: string;
            sku: string;
            productName: string;
            variantName?: string | null;
            orderedQuantity: number;
            requestedQuantity: number;
            approvedQuantity?: number | null;
            amountMinor?: number | null;
            /** @enum {string|null} */
            disposed?: "sellable" | "damaged" | "quarantine" | "scrap" | null;
            receivedQuantity: number;
            inspectedQuantity: number;
        };
        AdminAfterSalesCase: {
            /** Format: uuid */
            id: string;
            publicCaseNumber: string;
            /** Format: uuid */
            orderId: string;
            publicOrderNumber: string;
            caseType: components["schemas"]["AfterSalesCaseType"];
            status: components["schemas"]["AfterSalesCaseStatus"];
            reasonCode?: string | null;
            reason: string;
            /** @enum {string} */
            source: "admin" | "customer";
            requestedRefundMinor: number | null;
            approvedRefundMinor: number | null;
            refundedMinor: number;
            pendingRefundMinor: number;
            refundableMinor: number;
            currency: string;
            /** @enum {string} */
            orderStatus: "pending_payment" | "awaiting_confirmation" | "confirmed" | "processing" | "partially_shipped" | "shipped" | "completed" | "cancelled" | "on_hold";
            /** @enum {string} */
            paymentStatus: "created" | "requires_action" | "processing" | "succeeded" | "failed" | "cancelled" | "unknown" | "cod_due" | "collected" | "rejected" | "returned";
            orderTotalMinor: number;
            contactMasked?: string | null;
            /** Format: uuid */
            ownerId?: string | null;
            /** Format: date-time */
            approvedAt?: string | null;
            /** Format: uuid */
            approvedBy?: string | null;
            /** Format: date-time */
            rejectedAt?: string | null;
            rejectReason?: string | null;
            /** Format: date-time */
            closedAt?: string | null;
            version: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
            items: components["schemas"]["AdminAfterSalesItem"][];
            refunds: {
                /** Format: uuid */
                id: string;
                publicRefundNumber: string;
                status: components["schemas"]["RefundStatus"];
                amountMinor: number;
                currency: string;
                /** @enum {string} */
                channel: "cod" | "manual" | "online";
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                executedAt?: string | null;
            }[];
            returns: {
                /** Format: uuid */
                id: string;
                /** @enum {string} */
                status: "in_transit" | "received";
                carrierCode?: string | null;
                carrierName?: string | null;
                trackingNumber?: string | null;
                /** Format: date-time */
                shippedAt?: string | null;
                /** Format: date-time */
                receivedAt?: string | null;
                reference?: string | null;
            }[];
            receipts: {
                /** Format: uuid */
                id: string;
                /** Format: date-time */
                receivedAt: string;
                reference?: string | null;
                items: {
                    /** Format: uuid */
                    orderItemId: string;
                    quantity: number;
                }[];
            }[];
            inspections: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                orderItemId: string;
                quantity: number;
                /** @enum {string} */
                disposition: "sellable" | "damaged" | "quarantine" | "scrap";
                note?: string | null;
                /** Format: uuid */
                actorId?: string | null;
                /** Format: date-time */
                createdAt: string;
            }[];
            events: {
                /** Format: uuid */
                id: string;
                /** @enum {string} */
                type: "created" | "approved" | "rejected" | "return_registered" | "received" | "inspected" | "refund_requested" | "refunded" | "closed";
                fromStatus?: string | null;
                toStatus: components["schemas"]["AfterSalesCaseStatus"];
                note?: string | null;
                /** Format: uuid */
                actorId?: string | null;
                /** Format: date-time */
                createdAt: string;
            }[];
            /** @description Present only for sessions holding customers.read_pii. */
            contact?: {
                email: string | null;
                phone: string | null;
                fullName: string | null;
            };
        };
        AfterSalesCaseEnvelope: {
            data: components["schemas"]["AdminAfterSalesCase"];
            meta: components["schemas"]["ResponseMeta"];
        };
        AfterSalesCaseListEnvelope: {
            data: {
                items: components["schemas"]["AdminAfterSalesCase"][];
                nextCursor: string | null;
                hasMore: boolean;
            };
            meta: components["schemas"]["ResponseMeta"];
        };
    };
    responses: {
        /** @description Configured identity database and checked migrations are ready. */
        ReadinessSuccess: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ReadinessStatusEnvelope"];
            };
        };
        /** @description AdminInvitationSuccess */
        AdminInvitationSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                /** @description Invitation version, not user version; required by resend/revoke. */
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AdminInvitationSummaryEnvelope"];
            };
        };
        /** @description MarketReviewSuccess */
        MarketReviewSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                /** @description New StoreConfiguration version after recording review; recording approval does not enable trading. */
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["MarketReviewRecordEnvelope"];
            };
        };
        /** @description HealthSuccess */
        HealthSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["HealthStatusEnvelope"];
            };
        };
        /** @description AdminMfaSetupRequired */
        AdminMfaSetupRequired: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                /** @description Sets ez_admin_setup; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/admin/auth/mfa. Short-lived enrollment capability bound to challengeId and browser. Grants no admin resource access. */
                "Set-Cookie"?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AdminMfaSetupChallengeEnvelope"];
            };
        };
        /** @description AdminMfaEnrollmentSuccess */
        AdminMfaEnrollmentSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AdminMfaEnrollmentEnvelope"];
            };
        };
        /** @description AdminMfaEnrollmentConfirmedSuccess */
        AdminMfaEnrollmentConfirmedSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                /** @description Rotates formal ez_admin_session (HttpOnly; Secure; SameSite=Lax; Path=/api/v1/admin); consumes and clears ez_admin_setup using its original Path; revokes previous admin sessions. Never include session credentials in JSON. */
                "Set-Cookie"?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AdminMfaEnrollmentConfirmedEnvelope"];
            };
        };
        /** @description AdminSessionListSuccess */
        AdminSessionListSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AdminSessionListEnvelope"];
            };
        };
        /** @description AdminSessionRevokedSuccess */
        AdminSessionRevokedSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AdminSessionRevokedEnvelope"];
            };
        };
        /** @description AdminSessionSuccess */
        AdminSessionSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                /** @description Do not cache admin identity or configuration responses. */
                "Cache-Control"?: "no-store";
                /** @description Login/MFA success issues or rotates ez_admin_session; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/admin. Session reads do not require reissuing it. No session credential in JSON. */
                "Set-Cookie"?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AdminSessionEnvelope"];
            };
        };
        /** @description Password accepted; challenge only. No authenticated admin session is issued before MFA. Challenge is short-lived, single-use and bound to this browser authentication attempt. */
        AdminMfaRequired: {
            headers: {
                /** @description For verify_mfa issues ez_admin_challenge; for enroll_mfa issues ez_admin_setup with identical flags/path; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/admin/auth/mfa. Bound to challengeId and authentication attempt. MFA success consumes it and clears this cookie with the same Path. Never issues ez_admin_session here. */
                "Set-Cookie"?: string;
                "X-Request-Id": components["headers"]["X-Request-Id"];
                /** @description Do not cache admin identity or configuration responses. */
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AdminAuthenticationChallengeEnvelope"];
            };
        };
        /** @description Uniform accepted response for valid requests, whether the email exists or not. Completion revokes all existing sessions and does not log the user in. */
        PasswordResetRequestAccepted: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                /** @description Do not cache admin identity or configuration responses. */
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["PasswordResetAcceptedEnvelope"];
            };
        };
        /** @description AdminUserSuccess */
        AdminUserSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                /** @description Do not cache admin identity or configuration responses. */
                "Cache-Control"?: "no-store";
                /** @description Quoted decimal resource version; echo unchanged as If-Match. */
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AdminUserEnvelope"];
            };
        };
        /** @description AdminUserListSuccess */
        AdminUserListSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                /** @description Do not cache admin identity or configuration responses. */
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AdminUserListEnvelope"];
            };
        };
        /** @description AdminSessionsRevokedSuccess */
        AdminSessionsRevokedSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                /** @description Do not cache admin identity or configuration responses. */
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AdminSessionsRevokedEnvelope"];
            };
        };
        /** @description AdminRoleSuccess */
        AdminRoleSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                /** @description Do not cache admin identity or configuration responses. */
                "Cache-Control"?: "no-store";
                /** @description Quoted decimal resource version; echo unchanged as If-Match. */
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AdminRoleEnvelope"];
            };
        };
        /** @description AdminAuditLogListSuccess */
        AdminAuditLogListSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                /** @description Do not cache audit records. */
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AdminAuditLogListEnvelope"];
            };
        };
        /** @description AdminRoleListSuccess */
        AdminRoleListSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                /** @description Do not cache admin identity or configuration responses. */
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AdminRoleListEnvelope"];
            };
        };
        /** @description StoreConfigurationSuccess */
        StoreConfigurationSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                /** @description Do not cache admin identity or configuration responses. */
                "Cache-Control"?: "no-store";
                /** @description Quoted decimal resource version; echo unchanged as If-Match. */
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["StoreConfigurationEnvelope"];
            };
        };
        /** @description Successful request */
        Success: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["SuccessEnvelope"];
            };
        };
        /** @description Stock page with server-computed availability */
        InventoryListSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["InventoryListEnvelope"];
            };
        };
        /** @description Append-only stock movement page */
        InventoryMovementListSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["InventoryMovementListEnvelope"];
            };
        };
        /** @description Low-stock threshold page */
        InventoryThresholdListSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["InventoryThresholdListEnvelope"];
            };
        };
        /** @description The recorded adjustment with the resulting stock position */
        InventoryAdjustmentSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["InventoryAdjustmentEnvelope"];
            };
        };
        /** @description The stored low-stock threshold with its new version */
        InventoryThresholdSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["InventoryThresholdEnvelope"];
            };
        };
        /** @description Coupon rule with usage counters */
        CouponSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                /** @description Coupon rule version; echo as If-Match on updates. */
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["CouponEnvelope"];
            };
        };
        /** @description The created coupon rule */
        CouponCreated: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["CouponEnvelope"];
            };
        };
        /** @description Coupon rule page */
        CouponListSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["CouponListEnvelope"];
            };
        };
        /** @description Redemptions of one coupon, newest first */
        CouponRedemptionListSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["CouponRedemptionListEnvelope"];
            };
        };
        /** @description Payment ledger page */
        PaymentListSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["PaymentListEnvelope"];
            };
        };
        /** @description Payment ledger entry with its append-only event history */
        PaymentSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["PaymentEnvelope"];
            };
        };
        /** @description Payment method configurations with redacted credential status */
        PaymentMethodListSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["PaymentMethodListEnvelope"];
            };
        };
        /** @description Updated payment method configuration; credentials are never echoed */
        PaymentMethodSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                /** @description Configuration version for the next If-Match */
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["PaymentMethodEnvelope"];
            };
        };
        /** @description After-sales case with its timeline, returns, receipts and refunds */
        AfterSalesCaseSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                /** @description Case version for the next If-Match */
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AfterSalesCaseEnvelope"];
            };
        };
        /** @description Newly created after-sales case in submitted state */
        AfterSalesCaseCreated: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AfterSalesCaseEnvelope"];
            };
        };
        /** @description After-sales case page */
        AfterSalesCaseListSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AfterSalesCaseListEnvelope"];
            };
        };
        /** @description Refund ledger entry with its append-only event history */
        RefundSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["RefundEnvelope"];
            };
        };
        /** @description Refund request recorded in requested state; no money has moved yet */
        RefundCreated: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["RefundEnvelope"];
            };
        };
        /** @description Refund ledger page */
        RefundListSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["RefundListEnvelope"];
            };
        };
        /** @description Recorded payment outcome together with the projected order payment state */
        PaymentResultSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["PaymentResultEnvelope"];
            };
        };
        /** @description Uniform response for a syntactically valid OTP request; never reveals membership existence. Challenge ID is a correlation handle, not an authentication secret. */
        OtpChallengeAccepted: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["OtpChallengeEnvelope"];
            };
        };
        /** @description Product object */
        ProductSuccess: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ProductEnvelope"];
            };
        };
        /** @description Product collection */
        ProductListSuccess: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ProductListEnvelope"];
            };
        };
        /** @description Public product object with only published and eligible fields */
        PublicProductSuccess: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["PublicProductEnvelope"];
            };
        };
        /** @description Public product collection */
        PublicProductListSuccess: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["PublicProductListEnvelope"];
            };
        };
        /** @description Product publication result */
        ProductPublishSuccess: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ProductPublishEnvelope"];
            };
        };
        /** @description Import job and counters */
        ImportJobSuccess: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ImportJobEnvelope"];
            };
        };
        /** @description Import validation preview; no product rows are written */
        ImportPreviewSuccess: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ImportPreviewEnvelope"];
            };
        };
        /** @description Authoritative checkout quote */
        QuoteSuccess: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["QuoteEnvelope"];
            };
        };
        /** @description Delivery methods for the guest cart and destination; fees are computed server-side from the live cart subtotal */
        ShippingMethodsSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ShippingMethodsEnvelope"];
            };
        };
        /** @description Guest cart with live prices and availability */
        CartSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["CartEnvelope"];
            };
        };
        /** @description Guest cart created */
        CartCreatedSuccess: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                /** @description ez_guest_cart (HttpOnly session token) and ez_cart_csrf (readable double-submit token); both scoped to /api/v1. */
                "Set-Cookie"?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["CartEnvelope"];
            };
        };
        /** @description Created order and next payment action */
        OrderCreatedSuccess: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["OrderCreatedEnvelope"];
            };
        };
        /** @description Order collection with masked contact fields */
        OrderListSuccess: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["OrderListEnvelope"];
            };
        };
        /** @description Order snapshot and status history */
        OrderDetailSuccess: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["OrderDetailEnvelope"];
            };
        };
        /** @description Category tree in stable position order */
        CategoryListSuccess: {
            headers: {
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["CategoryListEnvelope"];
            };
        };
        /** @description Category with translations */
        CategorySuccess: {
            headers: {
                "Cache-Control"?: "no-store";
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["CategoryEnvelope"];
            };
        };
        /** @description Brand list */
        BrandListSuccess: {
            headers: {
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["BrandListEnvelope"];
            };
        };
        /** @description Brand with translations */
        BrandSuccess: {
            headers: {
                "Cache-Control"?: "no-store";
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["BrandEnvelope"];
            };
        };
        /** @description Media library page in reverse chronological order; read URLs are short-lived */
        MediaAssetListSuccess: {
            headers: {
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["MediaAssetListEnvelope"];
            };
        };
        /** @description Media asset metadata with a short-lived read URL */
        MediaAssetSuccess: {
            headers: {
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["MediaAssetEnvelope"];
            };
        };
        /** @description Resource created */
        Created: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["SuccessEnvelope"];
            };
        };
        /** @description Request accepted for asynchronous processing */
        Accepted: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["SuccessEnvelope"];
            };
        };
        /** @description Malformed or invalidly signed request */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Missing, invalid, expired or revoked authentication */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Authenticated caller lacks the required permission */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Resource not found or not visible to caller */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description State, version, uniqueness or idempotency conflict */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Request shape or business validation failed */
        ValidationError: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Request rate exceeded */
        RateLimited: {
            headers: {
                "Retry-After": components["headers"]["Retry-After"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description A required service is temporarily unavailable */
        Unavailable: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Unexpected server error; response must not expose internal details */
        UnexpectedError: {
            headers: {
                "X-Request-Id": components["headers"]["X-Request-Id"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
    };
    parameters: {
        UuidId: string;
        PageKey: string;
        Slug: string;
        ProviderCode: string;
        ReportKey: string;
        Cursor: string;
        Limit: number;
        SearchQuery: string;
        Locale: "zh-CN" | "zh-HK" | "en";
        MarketCode: string;
        /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
        IfMatch: string;
        /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
        IdempotencyKey: string;
    };
    requestBodies: never;
    headers: {
        /** @description Correlation ID for this request. */
        "X-Request-Id": string;
        /** @description Seconds before a limited client may retry. */
        "Retry-After": number;
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getAdminInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AdminInvitationSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    resendAdminInvitation: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReasonRequest"];
            };
        };
        responses: {
            200: components["responses"]["AdminInvitationSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    revokeAdminInvitation: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReasonRequest"];
            };
        };
        responses: {
            200: components["responses"]["AdminInvitationSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    recordMarketReview: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                marketCode: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MarketReviewRequest"];
            };
        };
        responses: {
            200: components["responses"]["MarketReviewSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getHealthLive: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["HealthSuccess"];
            503: components["responses"]["Unavailable"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getHealthReady: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["ReadinessSuccess"];
            503: components["responses"]["Unavailable"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    bootstrapAdminOwner: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BootstrapOwnerRequest"];
            };
        };
        responses: {
            202: components["responses"]["AdminMfaSetupRequired"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    acceptAdminInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AcceptAdminInvitationRequest"];
            };
        };
        responses: {
            200: components["responses"]["AdminSessionSuccess"];
            202: components["responses"]["AdminMfaSetupRequired"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    authorizeAdminMfaEnrollment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AuthorizeMfaEnrollmentRequest"];
            };
        };
        responses: {
            202: components["responses"]["AdminMfaSetupRequired"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    startAdminMfaEnrollment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StartMfaEnrollmentRequest"];
            };
        };
        responses: {
            201: components["responses"]["AdminMfaEnrollmentSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    confirmAdminMfaEnrollment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfirmMfaEnrollmentRequest"];
            };
        };
        responses: {
            200: components["responses"]["AdminMfaEnrollmentConfirmedSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listOwnAdminSessions: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AdminSessionListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    revokeOwnAdminSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReasonRequest"];
            };
        };
        responses: {
            200: components["responses"]["AdminSessionRevokedSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listAdminUserSessions: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AdminSessionListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    adminLogin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminLoginRequest"];
            };
        };
        responses: {
            200: components["responses"]["AdminSessionSuccess"];
            202: components["responses"]["AdminMfaRequired"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    verifyAdminMfa: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MfaVerifyRequest"];
            };
        };
        responses: {
            200: components["responses"]["AdminSessionSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getAdminSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AdminSessionSuccess"];
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    logoutAdmin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session revoked */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    requestAdminPasswordReset: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasswordResetRequest"] | components["schemas"]["PasswordResetCompleteRequest"];
            };
        };
        responses: {
            202: components["responses"]["PasswordResetRequestAccepted"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listAdminUsers: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AdminUserListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    inviteAdminUser: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminUserInviteRequest"];
            };
        };
        responses: {
            201: components["responses"]["AdminUserSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getAdminUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AdminUserSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateAdminUser: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminUserPatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["AdminUserSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    revokeAdminUserSessions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReasonRequest"];
            };
        };
        responses: {
            200: components["responses"]["AdminSessionsRevokedSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listRoles: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AdminRoleListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createRole: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RoleWriteRequest"];
            };
        };
        responses: {
            201: components["responses"]["AdminRoleSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getRole: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AdminRoleSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateRole: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RolePatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["AdminRoleSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getStoreConfig: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["StoreConfigurationSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateStoreConfig: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StoreConfigPatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["StoreConfigurationSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listProducts: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                q?: components["parameters"]["SearchQuery"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["ProductListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createProduct: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProductWriteRequest"];
            };
        };
        responses: {
            201: components["responses"]["ProductSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getProduct: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["ProductSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateProduct: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProductPatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["ProductSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    publishProduct: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProductPublishRequest"];
            };
        };
        responses: {
            200: components["responses"]["ProductPublishSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    unpublishProduct: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReasonRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listCategories: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["CategoryListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createCategory: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CategoryWriteRequest"];
            };
        };
        responses: {
            201: components["responses"]["CategorySuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getCategory: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["CategorySuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateCategory: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CategoryPatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["CategorySuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listBrands: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["BrandListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createBrand: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BrandWriteRequest"];
            };
        };
        responses: {
            201: components["responses"]["BrandSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getBrand: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["BrandSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateBrand: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BrandPatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["BrandSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listMedia: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["MediaAssetListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getMedia: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["MediaAssetSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createMediaUploadTarget: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MediaUploadTargetRequest"];
            };
        };
        responses: {
            201: components["responses"]["Created"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    completeMediaUpload: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MediaUploadCompleteRequest"];
            };
        };
        responses: {
            201: components["responses"]["Created"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listPages: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createPage: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PageWriteRequest"];
            };
        };
        responses: {
            201: components["responses"]["Created"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getPage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updatePage: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PagePatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createPagePreviewToken: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PreviewRequest"];
            };
        };
        responses: {
            201: components["responses"]["Created"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    publishPage: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PagePublishRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            202: components["responses"]["Accepted"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    unpublishPage: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReasonRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    rollbackPage: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PageRollbackRequest"];
            };
        };
        responses: {
            201: components["responses"]["Created"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getMerchandisingDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                pageKey: components["parameters"]["PageKey"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    saveMerchandisingDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                pageKey: components["parameters"]["PageKey"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MerchandisingWriteRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createImportJob: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ImportCreateRequest"];
            };
        };
        responses: {
            201: components["responses"]["ImportJobSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getImportJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["ImportJobSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    validateImportJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["ImportPreviewSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    executeImportJob: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ImportExecuteRequest"];
            };
        };
        responses: {
            202: components["responses"]["ImportJobSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    cancelImportJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getImportErrorReport: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createExportJob: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExportCreateRequest"];
            };
        };
        responses: {
            202: components["responses"]["Accepted"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getExportJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getPublicStoreConfig: {
        parameters: {
            query: {
                locale: components["parameters"]["Locale"];
                marketCode: components["parameters"]["MarketCode"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listStorefrontProducts: {
        parameters: {
            query: {
                locale: components["parameters"]["Locale"];
                marketCode: components["parameters"]["MarketCode"];
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                q?: components["parameters"]["SearchQuery"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["PublicProductListSuccess"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getStorefrontProduct: {
        parameters: {
            query: {
                locale: components["parameters"]["Locale"];
                marketCode: components["parameters"]["MarketCode"];
            };
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["PublicProductSuccess"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listStorefrontCategories: {
        parameters: {
            query: {
                locale: components["parameters"]["Locale"];
                marketCode: components["parameters"]["MarketCode"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getStorefrontPage: {
        parameters: {
            query: {
                locale: components["parameters"]["Locale"];
                marketCode: components["parameters"]["MarketCode"];
            };
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getStorefrontCollection: {
        parameters: {
            query: {
                locale: components["parameters"]["Locale"];
                marketCode: components["parameters"]["MarketCode"];
            };
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getCart: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["CartSuccess"];
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createCart: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            201: components["responses"]["CartCreatedSuccess"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    addCartItem: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CartItemWriteRequest"];
            };
        };
        responses: {
            200: components["responses"]["CartSuccess"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    removeCartItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cart item removed */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateCartItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CartItemUpdateRequest"];
            };
        };
        responses: {
            200: components["responses"]["CartSuccess"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listCheckoutShippingMethods: {
        parameters: {
            query: {
                countryCode: string;
                regionCode?: string;
                locale?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["ShippingMethodsSuccess"];
            401: components["responses"]["Unauthorized"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createCheckoutQuote: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CheckoutQuoteRequest"];
            };
        };
        responses: {
            200: components["responses"]["QuoteSuccess"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            503: components["responses"]["Unavailable"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createOrderFromQuote: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CheckoutOrderRequest"];
            };
        };
        responses: {
            201: components["responses"]["OrderCreatedSuccess"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            503: components["responses"]["Unavailable"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    requestMemberOtp: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OtpRequest"];
            };
        };
        responses: {
            202: components["responses"]["OtpChallengeAccepted"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            503: components["responses"]["Unavailable"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    verifyMemberOtp: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OtpVerifyRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    logoutMember: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Member session revoked */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getMemberProfile: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listMemberOrders: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getMemberPoints: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listMemberCoupons: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    receivePaymentWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider: components["parameters"]["ProviderCode"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": Record<string, never>;
            };
        };
        responses: {
            202: components["responses"]["Accepted"];
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            /** @description Webhook body too large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            429: components["responses"]["RateLimited"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listOrders: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                q?: components["parameters"]["SearchQuery"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["OrderListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getOrder: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["OrderDetailSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    cancelOrder: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OrderCancelRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    changeOrderAddress: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OrderAddressChangeRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    addOrderNote: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OrderNoteRequest"];
            };
        };
        responses: {
            201: components["responses"]["Created"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createShipment: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ShipmentCreateRequest"];
            };
        };
        responses: {
            201: components["responses"]["Created"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    dispatchShipment: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ShipmentDispatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    deliverShipment: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ShipmentDeliverRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listPayments: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                status?: components["schemas"]["PaymentStatus"];
                orderId?: string;
                providerCode?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["PaymentListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getPayment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["PaymentSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listPaymentMethods: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["PaymentMethodListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updatePaymentMethod: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PaymentMethodPatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["PaymentMethodSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    recordOrderPaymentResult: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OrderPaymentResultRequest"];
            };
        };
        responses: {
            200: components["responses"]["PaymentResultSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listRefunds: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                status?: components["schemas"]["RefundStatus"];
                orderId?: string;
                caseId?: string;
                paymentId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["RefundListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createRefund: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RefundCreateRequest"];
            };
        };
        responses: {
            201: components["responses"]["RefundCreated"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getRefund: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["RefundSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    approveRefund: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReasonRequest"];
            };
        };
        responses: {
            200: components["responses"]["RefundSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    rejectRefund: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReasonRequest"];
            };
        };
        responses: {
            200: components["responses"]["RefundSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    executeRefund: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RefundExecuteRequest"];
            };
        };
        responses: {
            200: components["responses"]["RefundSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            503: components["responses"]["Unavailable"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listSettlements: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    importSettlement: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SettlementImportRequest"];
            };
        };
        responses: {
            202: components["responses"]["Accepted"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    previewSettlement: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    confirmSettlement: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SettlementConfirmRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    resolveSettlementDifference: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
                lineId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SettlementResolveRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listShippingZones: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createShippingZone: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ShippingZoneWriteRequest"];
            };
        };
        responses: {
            201: components["responses"]["Created"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getShippingZone: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateShippingZone: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ShippingZonePatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listShippingRates: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createShippingRate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ShippingRateWriteRequest"];
            };
        };
        responses: {
            201: components["responses"]["Created"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getShippingRate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateShippingRate: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ShippingRatePatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    previewShippingQuote: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ShippingQuotePreviewRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listCustomers: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                q?: components["parameters"]["SearchQuery"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createCustomer: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CustomerWriteRequest"];
            };
        };
        responses: {
            201: components["responses"]["Created"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getCustomer: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateCustomer: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CustomerWriteRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listMembers: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createMemberProfile: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MemberWriteRequest"];
            };
        };
        responses: {
            201: components["responses"]["Created"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateMember: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MemberPatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getAdminMemberPoints: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    adjustMemberPoints: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PointsAdjustmentRequest"];
            };
        };
        responses: {
            201: components["responses"]["Created"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getLoyaltyOverview: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateLoyaltySettings: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LoyaltySettingPatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createMembershipTier: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MembershipTierWriteRequest"];
            };
        };
        responses: {
            201: components["responses"]["Created"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateMembershipTier: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MembershipTierPatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createPrivacyRequest: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PrivacyRequestCreate"];
            };
        };
        responses: {
            201: components["responses"]["Created"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getPrivacyRequest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    verifyPrivacyRequestIdentity: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PrivacyVerifyRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    completePrivacyRequest: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PrivacyCompleteRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listCoupons: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                q?: components["parameters"]["SearchQuery"];
                status?: "active" | "disabled";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["CouponListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createCoupon: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CouponWriteRequest"];
            };
        };
        responses: {
            201: components["responses"]["CouponCreated"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getCoupon: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["CouponSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateCoupon: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CouponPatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["CouponSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listCouponRedemptions: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["CouponRedemptionListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    disableCoupon: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReasonRequest"];
            };
        };
        responses: {
            200: components["responses"]["CouponSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createCouponBatch: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CouponBatchRequest"];
            };
        };
        responses: {
            201: components["responses"]["Created"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    issueCouponBatch: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CouponBatchIssueRequest"];
            };
        };
        responses: {
            202: components["responses"]["Accepted"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listInventory: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                q?: components["parameters"]["SearchQuery"];
                variantId?: string;
                /** @description 1 or true keeps rows at or below their low-stock threshold. */
                lowStock?: "1" | "0" | "true" | "false";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["InventoryListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listStockMovements: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                variantId?: string;
                type?: components["schemas"]["InventoryMovementType"];
                orderId?: string;
                caseId?: string;
                from?: string;
                to?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["InventoryMovementListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createInventoryAdjustment: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InventoryAdjustmentRequest"];
            };
        };
        responses: {
            201: components["responses"]["InventoryAdjustmentSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getInventoryThresholds: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["InventoryThresholdListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateInventoryThresholds: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InventoryThresholdsPatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["InventoryThresholdSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getNotificationSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    updateNotificationSettings: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["NotificationSettingsPatchRequest"];
            };
        };
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listNotificationJobs: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    retryNotificationJob: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReasonRequest"];
            };
        };
        responses: {
            202: components["responses"]["Accepted"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getReport: {
        parameters: {
            query: {
                from: string;
                to: string;
                timezone: string;
                marketCode?: string;
                paymentMethodCode?: string;
            };
            header?: never;
            path: {
                reportKey: components["parameters"]["ReportKey"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createReportExport: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReportExportRequest"];
            };
        };
        responses: {
            202: components["responses"]["Accepted"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getReportExport: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listAuditLogs: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AdminAuditLogListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            503: components["responses"]["Unavailable"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createBackupJob: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BackupRequest"];
            };
        };
        responses: {
            202: components["responses"]["Accepted"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getOperationJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Success"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    listAfterSalesCases: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                status?: components["schemas"]["AfterSalesCaseStatus"];
                caseType?: components["schemas"]["AfterSalesCaseType"];
                orderId?: string;
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AfterSalesCaseListSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    createAfterSalesCase: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AfterSalesCreateRequest"];
            };
        };
        responses: {
            201: components["responses"]["AfterSalesCaseCreated"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    getAfterSalesCase: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AfterSalesCaseSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    approveAfterSalesCase: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReasonRequest"];
            };
        };
        responses: {
            200: components["responses"]["AfterSalesCaseSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    rejectAfterSalesCase: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReasonRequest"];
            };
        };
        responses: {
            200: components["responses"]["AfterSalesCaseSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    registerAfterSalesReturnShipment: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReturnShipmentRequest"];
            };
        };
        responses: {
            201: components["responses"]["AfterSalesCaseSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    receiveAfterSalesReturn: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReturnReceiptRequest"];
            };
        };
        responses: {
            200: components["responses"]["AfterSalesCaseSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    inspectAfterSalesReturn: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReturnInspectionRequest"];
            };
        };
        responses: {
            200: components["responses"]["AfterSalesCaseSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    refundAfterSalesCase: {
        parameters: {
            query?: never;
            header: {
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AfterSalesRefundRequest"];
            };
        };
        responses: {
            201: components["responses"]["RefundCreated"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
    closeAfterSalesCase: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag for optimistic concurrency; stale value returns VERSION_CONFLICT. */
                "If-Match": components["parameters"]["IfMatch"];
                /** @description Same key and same request returns the original result; same key with different request returns IDEMPOTENCY_CONFLICT. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                id: components["parameters"]["UuidId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReasonRequest"];
            };
        };
        responses: {
            200: components["responses"]["AfterSalesCaseSuccess"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            default: components["responses"]["UnexpectedError"];
        };
    };
}
