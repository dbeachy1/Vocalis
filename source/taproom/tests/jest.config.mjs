import { workerCount } from './util/worker-count.js';

export default {
    verbose: true,
    transform: {},
    // Shared with the browser suite — `util/worker-count.js` holds the measurements behind the number,
    // because what a worker costs is a fact about booting SillyTavern, not about jest.
    maxWorkers: workerCount(),
    testEnvironment: 'node',
    testPathIgnorePatterns: ['/node_modules/', '<rootDir>/integration/'],
    globalSetup: '<rootDir>/util/global-setup.js',
    globalTeardown: '<rootDir>/util/global-teardown.js',
};
