/**
 * @core/cluster-identity — the identity cluster module + its public port.
 */
export { IdentityModule } from './identity.module.js';
export { AuthService } from './auth/auth.service.js';
export {
  type PublicUser,
  type UserLookup,
  USER_LOOKUP,
} from './public-api.js';
