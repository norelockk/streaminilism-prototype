import * as fs from 'fs';
import * as path from 'path';
import util from 'util';

export enum LogLevel {
  NONE,
  INFO,
  WARN,
  ERROR,
  DEBUG,
}

export interface LogContext {
  timestamp: string;
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
  className?: string;
  functionName?: string;
  stack?: string;
}

export interface LoggerOptions {
  showTimestamp?: boolean;
  showFileName?: boolean;
  showLineNumbers?: boolean;
  showClassName?: boolean;
  showFunctionName?: boolean;
  showStackTrace?: boolean;
  customFormat?: (level: LogLevel, message: string, context: LogContext) => string;
  // File logging options
  logToFile?: boolean;
  logDirectory?: string;
  maxFileSize?: number; // in bytes
  maxFiles?: number;
  fileNamePattern?: string;
}

class FileHandler {
  private currentLogFile: string;
  private currentFileSize: number = 0;

  constructor(
    private logDirectory: string,
    private maxFileSize: number,
    private maxFiles: number,
    private fileNamePattern: string
  ) {
    this.ensureLogDirectory();
    this.currentLogFile = this.generateLogFileName();
    this.currentFileSize = this.getCurrentFileSize();
  }

  private ensureLogDirectory(): void {
    if (!fs.existsSync(this.logDirectory)) {
      fs.mkdirSync(this.logDirectory, { recursive: true });
    }
  }

  private getCurrentFileSize(): number {
    try {
      return fs.statSync(this.currentLogFile).size;
    } catch {
      return 0;
    }
  }

  private generateLogFileName(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = this.fileNamePattern
      .replace('{timestamp}', timestamp)
      .replace('{level}', 'combined');
    return path.join(this.logDirectory, fileName);
  }

  private rotateLogFile(): void {
    const files = fs.readdirSync(this.logDirectory)
      .filter(file => file.endsWith('.log'))
      .map(file => ({
        name: file,
        time: fs.statSync(path.join(this.logDirectory, file)).birthtime
      }))
      .sort((a, b) => b.time.getTime() - a.time.getTime());

    // Remove oldest files if we exceed maxFiles
    while (files.length >= this.maxFiles) {
      const oldestFile = files.pop();
      if (oldestFile) {
        try {
          fs.unlinkSync(path.join(this.logDirectory, oldestFile.name));
        } catch (error) {
          console.error(`Failed to delete old log file: ${oldestFile.name}`, error);
        }
      }
    }

    this.currentLogFile = this.generateLogFileName();
    this.currentFileSize = 0;
  }

  public writeLog(message: string): void {
    const logMessage = message + '\n';
    const messageSize = Buffer.byteLength(logMessage);

    // Check if we need to rotate the log file
    if (this.currentFileSize + messageSize > this.maxFileSize) {
      this.rotateLogFile();
    }

    // Append to the current log file
    try {
      fs.appendFileSync(this.currentLogFile, logMessage);
      this.currentFileSize += messageSize;
    } catch (error) {
      console.error(`Failed to write to log file: ${this.currentLogFile}`, error);
      // Attempt to recover by creating a new log file
      this.rotateLogFile();
      try {
        fs.appendFileSync(this.currentLogFile, logMessage);
        this.currentFileSize = messageSize;
      } catch (retryError) {
        console.error(`Failed to write to new log file after rotation`, retryError);
      }
    }
  }
}

export class Logger {
  private static logLevel: LogLevel = LogLevel.DEBUG;
  private static options: LoggerOptions = {
    showTimestamp: true,
    showFileName: true,
    showLineNumbers: true,
    showClassName: true,
    showFunctionName: true,
    showStackTrace: false,
    // File logging defaults
    maxFiles: 100,
    logToFile: true,
    maxFileSize: 10 * 1024 * 1024, // 10MB
    logDirectory: path.join(process.cwd(), 'logs'),
    fileNamePattern: 'app-{timestamp}.log'
  };

  private static fileHandler: FileHandler | null = new FileHandler(
    Logger.options.logDirectory!,
    Logger.options.maxFileSize!,
    Logger.options.maxFiles!,
    Logger.options.fileNamePattern!
  );

  static setLogLevel(level: LogLevel): void {
    Logger.logLevel = level;
  }

  static setOptions(options: Partial<LoggerOptions>): void {
    Logger.options = { ...Logger.options, ...options };

    // Initialize file handler if logging to file is enabled
    if (Logger.options.logToFile && !Logger.fileHandler) {
      Logger.fileHandler = new FileHandler(
        Logger.options.logDirectory!,
        Logger.options.maxFileSize!,
        Logger.options.maxFiles!,
        Logger.options.fileNamePattern!
      );
    }
  }

  private static formatValue(value: any): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    
    if (value instanceof Error) {
      return value.stack || value.toString();
    }

    if (typeof value === 'object') {
      try {
        // Handle circular references and complex objects
        return util.inspect(value, {
          depth: 4,
          colors: false,
          maxArrayLength: 100,
          maxStringLength: 200,
          breakLength: 80,
          compact: true
        });
      } catch (err) {
        return String(value);
      }
    }

    return String(value);
  }

  private static formatArguments(...args: any[]): string {
    return args
      .map(arg => Logger.formatValue(arg))
      .join(' ');
  }

  private static getCallerInfo(): { fileName?: string; lineNumber?: number; columnNumber?: number; className?: string; functionName?: string } {
    const error = new Error();
    const stack = error.stack?.split('\n');
    
    if (!stack || stack.length < 4) {
      return {};
    }

    const callerFrame = stack[3];
    const frameMatch = callerFrame.match(/at (?:(\w+)\.)?([^( ]+)(?: \((.+?):(\d+):(\d+)\))?/);
    
    if (!frameMatch) {
      return {};
    }

    const [, className, funcName, fileName, line, column] = frameMatch;
    
    let cleanFunctionName = funcName;
    if (className && funcName.startsWith(className + '.')) {
      cleanFunctionName = funcName.substring(className.length + 1);
    }

    return {
      fileName: fileName,
      lineNumber: line ? parseInt(line, 10) : undefined,
      columnNumber: column ? parseInt(column, 10) : undefined,
      className: className || undefined,
      functionName: cleanFunctionName
    };
  }

  private static formatMessage(level: LogLevel, args: any[], context: LogContext): string {
    if (Logger.options.customFormat) {
      return Logger.options.customFormat(level, Logger.formatArguments(...args), context);
    }

    const parts: string[] = [];
    
    if (Logger.options.showTimestamp) {
      parts.push(`[${context.timestamp}]`);
    }

    parts.push(`[${LogLevel[level]}]`);

    if (Logger.options.showFileName && context.fileName) {
      const shortFileName = context.fileName.split('/').pop() || context.fileName;
      parts.push(`[${shortFileName}${
        Logger.options.showLineNumbers && context.lineNumber 
          ? `:${context.lineNumber}:${context.columnNumber}` 
          : ''
      }]`);
    }

    if ((Logger.options.showClassName && context.className) || 
        (Logger.options.showFunctionName && context.functionName)) {
      const classFunc = [
        Logger.options.showClassName ? context.className : null,
        Logger.options.showFunctionName ? context.functionName : null
      ].filter(Boolean).join('::');
      if (classFunc) {
        parts.push(`[${classFunc}]`);
      }
    }

    parts.push(Logger.formatArguments(...args));

    if (Logger.options.showStackTrace && context.stack) {
      parts.push(`\nStack Trace:\n${context.stack}`);
    }

    return parts.join(' ');
  }

  static log(level: LogLevel, ...args: any[]): void {
    if (level < Logger.logLevel) {
      return;
    }

    const callerInfo = Logger.getCallerInfo();
    const context: LogContext = {
      timestamp: new Date().toISOString(),
      ...callerInfo,
      stack: Logger.options.showStackTrace ? new Error().stack : undefined
    };

    const formattedMessage = Logger.formatMessage(level, args, context);

    // Console logging
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(formattedMessage);
        break;
      case LogLevel.INFO:
        console.info(formattedMessage);
        break;
      case LogLevel.WARN:
        console.warn(formattedMessage);
        break;
      case LogLevel.ERROR:
        console.error(formattedMessage);
        break;
    }

    // File logging
    if (Logger.options.logToFile && Logger.fileHandler) {
      Logger.fileHandler.writeLog(formattedMessage);
    }
  }
}

// Example usage:
/*
// Configure logger
Logger.setOptions({
  logToFile: true,
  logDirectory: 'logs',
  maxFileSize: 5 * 1024 * 1024, // 5MB
  maxFiles: 3,
  fileNamePattern: 'app-{timestamp}.log'
});

// Basic logging
Logger.debug('Starting application');
Logger.info('Server running on port', 3000);

// Object logging
Logger.info('Processing order:', {
  id: 'ORD-123',
  items: [
    { id: 1, name: 'Item 1', price: 10 },
    { id: 2, name: 'Item 2', price: 20 }
  ],
  customer: { id: 'CUST-456', name: 'John Doe' }
});

// Error logging
try {
  throw new Error('Database connection failed');
} catch (error) {
  Logger.error('Failed to connect:', error);
}

// Multiple arguments
Logger.warn('Memory usage', process.memoryUsage(), 'exceeds threshold');

// Class method logging
class UserService {
  createUser(userData: any) {
    Logger.info('Creating user:', userData);
    // Output: [2024-02-24T10:30:15.123Z] [INFO] [user-service.ts:10] [UserService::createUser] Creating user: { name: 'John', email: 'john@example.com' }
  }
}
*/