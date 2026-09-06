/* Deployment configuration.
 *
 * There is no client SECRET here and there must never be one. This app uses the
 * browser token flow, which authenticates with the client ID alone -- a secret
 * shipped to a browser is not secret. Google issues one because the same
 * credential type also supports server-side flows; it is unused here.
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
  googleClientId: '962508343512-h2jburcjo1nlikmnhcetstpbsrr9o731.apps.googleusercontent.com'
};
