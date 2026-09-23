/** Reflector metadata keys for the edge guards. Centralised so guards + decorators agree. */
export const META_PUBLIC = 'core:public';
export const META_PERMISSIONS = 'core:permissions';
export const META_PORTALS = 'core:portals';
export const META_FLAG = 'core:flag';
export const META_FRESH_AUTH = 'core:fresh-auth';
/** `@SelfService()` — route acts only on the caller's own identity/session (`@CurrentUser()`),
 * no `:id`-style target of someone else's data. See self-service.decorator.ts. */
export const META_SELF_SERVICE = 'core:self-service';
/** `@DynamicPermission('reason')` — the permission can't be statically declared (varies by a
 * route param); the SERVICE performs its own per-resource `ForbiddenException` check before any
 * read/write. See dynamic-permission.decorator.ts. */
export const META_DYNAMIC_PERMISSION = 'core:dynamic-permission';
/** `@AnyAuthenticated('reason')` — deliberately open to every authenticated caller with NO
 * permission gate at all; the service self-masks or filters its output per caller instead of
 * denying. See any-authenticated.decorator.ts. */
export const META_ANY_AUTHENTICATED = 'core:any-authenticated';
