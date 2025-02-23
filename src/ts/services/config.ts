import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { AppConfig, ServerConfig, VodConfig, PlatformConfig, CDNConfig } from '../types';
import { defaultConfig } from '../utils';

interface ConfigEvents {
  'configUpdated': (config: AppConfig) => void;
  'configError': (error: Error) => void;
  'configBackupCreated': (backupPath: string) => void;
}

export class ConfigService extends EventEmitter {
  private static CONFIG_PATH = './streaming-config.json';
  private static BACKUP_DIR = './config-backups';
  private static MAX_BACKUPS = 5;
  private static instance: ConfigService;
  
  private config: AppConfig;
  private isReloading: boolean = false;
  private lastValidConfig: AppConfig;
  private configVersion: number = 1;

  private constructor() {
    super();
    this.createBackupDirectory();
    this.config = this.loadConfiguration();
    this.lastValidConfig = { ...this.config };
    this.watchConfigFile();
  }

  static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  private createBackupDirectory(): void {
    if (!fs.existsSync(ConfigService.BACKUP_DIR)) {
      fs.mkdirSync(ConfigService.BACKUP_DIR, { recursive: true });
    }
  }

  private loadConfiguration(): AppConfig {
    try {
      if (fs.existsSync(ConfigService.CONFIG_PATH)) {
        const config = JSON.parse(fs.readFileSync(ConfigService.CONFIG_PATH, 'utf8'));
        return this.validateAndNormalizeConfig(config);
      }
      return this.createDefaultConfig();
    } catch (error) {
      console.error('[Config] Error loading configuration:', error);
      
      // Try to load from backup if main config fails
      const backup = this.loadLatestBackup();
      if (backup) {
        console.log('[Config] Loaded configuration from backup');
        return backup;
      }

      console.error('[Config] No valid configuration found, using default');
      return this.createDefaultConfig();
    }
  }

  private loadLatestBackup(): AppConfig | null {
    try {
      const backups = fs.readdirSync(ConfigService.BACKUP_DIR)
        .filter(file => file.endsWith('.json'))
        .sort()
        .reverse();

      for (const backup of backups) {
        try {
          const config = JSON.parse(
            fs.readFileSync(path.join(ConfigService.BACKUP_DIR, backup), 'utf8')
          );
          if (this.validateConfig(config)) {
            return config;
          }
        } catch (e) {
          continue;
        }
      }
    } catch (error) {
      console.error('[Config] Error loading backup:', error);
    }
    return null;
  }

  private validateAndNormalizeConfig(config: Partial<AppConfig>): AppConfig {
    // Validate core structure
    if (!this.validateConfig(config)) {
      throw new Error('Invalid configuration structure');
    }

    // Create a copy of default config without platforms
    const defaultWithoutPlatforms = { 
      ...defaultConfig,
      platforms: config.platforms || {}  // Use provided platforms or empty object
    };

    // Deep merge with modified default config
    const normalized = this.deepMerge(defaultWithoutPlatforms, config);

    // Validate specific sections
    this.validateServerConfig(normalized.server);
    this.validateVodConfig(normalized.vod);
    this.validatePlatformConfigs(normalized.platforms);
    if (normalized.cdn) {
      this.validateCDNConfig(normalized.cdn);
    }

    return normalized;
  }

  private validateConfig(config: Partial<AppConfig>): boolean {
    return !!(config.server && config.platforms && config.vod);
  }

  private validateServerConfig(config: ServerConfig): void {
    if (!config.rtmp?.port || !config.rtmp.chunk_size) {
      throw new Error('Invalid RTMP server configuration');
    }
    if (config.http && (!config.http.port || !config.http.mediaroot)) {
      throw new Error('Invalid HTTP server configuration');
    }
  }

  private validateVodConfig(config: VodConfig): void {
    if (!config.recordingsDir || !config.hlsDir) {
      throw new Error('Invalid VOD configuration: missing required directories');
    }
    if (config.retention.days < 0 || config.retention.cleanupInterval < 0) {
      throw new Error('Invalid VOD retention configuration');
    }
  }

  private validatePlatformConfigs(platforms: Record<string, PlatformConfig>): void {
    Object.entries(platforms).forEach(([name, config]) => {
      if (!config.url || !config.options || !config.options.input || !config.options.output) {
        throw new Error(`Invalid platform configuration for ${name}`);
      }
    });
  }

  private validateCDNConfig(config: CDNConfig): void {
    if (config.enabled) {
      if (!config.credentials?.storageKey || !config.credentials?.storageZone) {
        throw new Error('Invalid CDN configuration: missing credentials');
      }
      if (!config.paths?.recordings || !config.paths?.hls) {
        throw new Error('Invalid CDN configuration: missing paths');
      }
    }
  }

  private createDefaultConfig(): AppConfig {
    try {
      const config = {
        ...defaultConfig,
        platforms: {} // Start with empty platforms
      };
      fs.writeFileSync(ConfigService.CONFIG_PATH, JSON.stringify(config, null, 2));
      return config;
    } catch (error) {
      console.error('[Config] Error creating default configuration:', error);
      throw error;
    }
  }

  private createBackup(): void {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(
        ConfigService.BACKUP_DIR,
        `config-backup-${timestamp}-v${this.configVersion}.json`
      );
      
      fs.writeFileSync(backupPath, JSON.stringify(this.config, null, 2));
      this.emit('configBackupCreated', backupPath);

      // Clean up old backups
      this.cleanupOldBackups();
    } catch (error) {
      console.error('[Config] Error creating backup:', error);
    }
  }

  private cleanupOldBackups(): void {
    try {
      const backups = fs.readdirSync(ConfigService.BACKUP_DIR)
        .filter(file => file.endsWith('.json'))
        .sort()
        .reverse();

      if (backups.length > ConfigService.MAX_BACKUPS) {
        backups.slice(ConfigService.MAX_BACKUPS).forEach(backup => {
          fs.unlinkSync(path.join(ConfigService.BACKUP_DIR, backup));
        });
      }
    } catch (error) {
      console.error('[Config] Error cleaning up backups:', error);
    }
  }

  private watchConfigFile(): void {
    fs.watchFile(ConfigService.CONFIG_PATH, (curr, prev) => {
      if (curr.mtime !== prev.mtime && !this.isReloading) {
        this.reloadConfig();
      }
    });
  }

  private async reloadConfig(): Promise<void> {
    if (this.isReloading) return;

    this.isReloading = true;
    try {
      console.log('[Config] Configuration file changed, reloading...');
      
      // Create backup before loading new config
      this.createBackup();

      const newConfig = this.loadConfiguration();
      this.config = newConfig;
      this.lastValidConfig = { ...newConfig };
      this.configVersion++;

      console.log('[Config] Configuration reloaded successfully');
      this.emit('configUpdated', this.config);
    } catch (error) {
      console.error('[Config] Error reloading configuration:', error);
      this.emit('configError', error as Error);
      
      // Rollback to last valid config
      this.config = { ...this.lastValidConfig };
      fs.writeFileSync(ConfigService.CONFIG_PATH, JSON.stringify(this.config, null, 2));
      console.log('[Config] Rolled back to last valid configuration');
    } finally {
      this.isReloading = false;
    }
  }

  private deepMerge(target: any, source: any): any {
    const output = { ...target };
    
    if (isObject(target) && isObject(source)) {
      Object.keys(source).forEach(key => {
        // Special case for platforms - don't merge with defaults
        if (key === 'platforms') {
          output[key] = { ...source[key] };
          return;
        }

        if (isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: { ...source[key] } });
          } else {
            output[key] = this.deepMerge(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;
  }

  // Public methods
  public getConfig(): AppConfig {
    return this.config;
  }

  public async updateConfig(newConfig: Partial<AppConfig>): Promise<void> {
    if (this.isReloading) {
      throw new Error('Cannot update config while reload is in progress');
    }

    try {
      // Create backup before updating
      this.createBackup();

      // Validate and merge new config
      const mergedConfig = this.validateAndNormalizeConfig({
        ...this.config,
        ...newConfig
      });

      // Update config
      this.config = mergedConfig;
      this.lastValidConfig = { ...mergedConfig };
      this.configVersion++;

      // Save to file
      await fs.promises.writeFile(
        ConfigService.CONFIG_PATH,
        JSON.stringify(this.config, null, 2)
      );

      this.emit('configUpdated', this.config);
    } catch (error) {
      this.emit('configError', error as Error);
      throw error;
    }
  }

  public getConfigVersion(): number {
    return this.configVersion;
  }

  public restoreBackup(version: number): boolean {
    try {
      const backups = fs.readdirSync(ConfigService.BACKUP_DIR)
        .filter(file => file.includes(`-v${version}.json`));

      if (backups.length === 0) {
        return false;
      }

      const backup = JSON.parse(
        fs.readFileSync(path.join(ConfigService.BACKUP_DIR, backups[0]), 'utf8')
      );

      if (this.validateConfig(backup)) {
        this.config = backup;
        fs.writeFileSync(ConfigService.CONFIG_PATH, JSON.stringify(backup, null, 2));
        this.emit('configUpdated', this.config);
        return true;
      }
    } catch (error) {
      console.error('[Config] Error restoring backup:', error);
    }
    return false;
  }

  // Event handling with TypeScript support
  public on<K extends keyof ConfigEvents>(
    event: K,
    listener: ConfigEvents[K]
  ): this {
    return super.on(event, listener);
  }

  public once<K extends keyof ConfigEvents>(
    event: K,
    listener: ConfigEvents[K]
  ): this {
    return super.once(event, listener);
  }

  public emit<K extends keyof ConfigEvents>(
    event: K,
    ...args: Parameters<ConfigEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}

// Helper function to check if value is an object
function isObject(item: any): boolean {
  return item && typeof item === 'object' && !Array.isArray(item);
}