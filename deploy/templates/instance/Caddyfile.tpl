{$SITE_DOMAIN} {
	reverse_proxy storefront:3002
}

www.{$SITE_DOMAIN} {
	redir https://{$SITE_DOMAIN}{uri} permanent
}

admin.{$SITE_DOMAIN} {
	reverse_proxy admin:3000
}
