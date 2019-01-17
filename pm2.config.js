module.exports = {
    apps: [{
        name: "antigifbot",
        script: "./dist/index.js",
        watch: false,
        env: {
            "NODE_ENV": "development",
        },
        env_production : {
            "NODE_ENV": "production",
        },
    }],
};
