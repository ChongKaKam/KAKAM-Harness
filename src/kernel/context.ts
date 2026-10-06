import type { ExtensionsService } from '../features/extensions/server';
import type { MemoryManager } from '../features/memory/manager';
import type { Database } from './database';
import type { HttpService } from './http';
import type { AuthService } from '../features/auth/server';
import type { ModelsService } from '../features/models/server';
import type { KHKernel } from './index';
import type { AdapterRegistry } from '../adapters/registry';
declare module 'cordis' {
  interface Context {
    db: Database;
    extensions: ExtensionsService;
    memory: MemoryManager;
    http: HttpService;
    auth: AuthService;
    models: ModelsService;
    adapters: AdapterRegistry;
    kernel: KHKernel;
  }
}
export {};
