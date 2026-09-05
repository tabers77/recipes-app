/* Deployment configuration.
 *
 * The OAuth client ID is PUBLIC by design -- it ships in every page that uses
 * Google sign-in. What restricts it is the "Authorized JavaScript origins" list
 * on the credential in Google Cloud, not secrecy. Committing it is correct.
 *
 * Leave it empty and the app works exactly as before, with Drive sync showing
 * as "not configured". Nothing else depends on it.
 *
 * To fill it in, see README.md, "Google Drive setup".
 */
'use strict';

window.RECIPES_CONFIG = {
  googleClientId: ''
};
