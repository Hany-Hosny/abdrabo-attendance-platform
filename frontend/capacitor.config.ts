import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.abdrabo.app',
  appName: 'Abdrabo Edu',
  webDir: 'dist',
  server: {
    url: 'https://abdrabo.up.railway.app',
    cleartext: false
  }
};

export default config;