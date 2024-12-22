export interface OpenAutoCompleteConfiguration {
  apiBase: string;
  apiKey: string;
  logCompletionManager: boolean;
}

export class ConfigContainer {
  public config!: OpenAutoCompleteConfiguration;
}
