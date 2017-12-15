const fs = require('fs');
const path = require('path');

let version;

class PackageReader {
    static get version() {
        if (!version) {
            version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')).version;
        }
        return version;
    }
}

module.exports = PackageReader;