// afterSign hook: notarise the built Mac app using notarytool with all three
// credentials read explicitly from environment variables. This avoids
// electron-builder's built-in auto-detection, which was not passing the Team ID.
const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') {
    return; // only notarise on macOS builds
  }

  // If credentials aren't present (e.g. a local unsigned build), skip quietly.
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    console.log('Skipping notarisation: Apple credentials not set.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`Notarising ${appName}.app with team ${teamId} …`);
  await notarize({
    tool: 'notarytool',
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });
  console.log(`Notarisation complete for ${appName}.app`);
};
