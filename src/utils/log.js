const util = require('util');

module.exports = (msg) => {
    if (msg)
        util.log(msg);
    else // Empty line
        console.log();
};