/*
 * Optional settings for CheckAudio.
 *
 * Google Drive import needs a Google Cloud project. See "Google Drive setup"
 * in README.md. These values are safe to publish: restrict the API key to
 * your site's address in the Google Cloud console.
 */
window.CHECKAUDIO_CONFIG = {
  googleApiKey: '',     // APIs & Services → Credentials → API key
  googleClientId: '',   // OAuth 2.0 Client ID (Web application), ends in .apps.googleusercontent.com
  googleAppId: '',      // Project number (Cloud console home page); lets the Picker grant file access
};
