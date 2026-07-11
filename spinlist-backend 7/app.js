/* cPanel / Phusion Passenger entry point.
   Passenger looks for "app.js" by default. We simply hand off to
   server.js, which detects Passenger and exports the app correctly. */
module.exports = require('./server.js');
