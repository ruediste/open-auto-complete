export interface OpenAutoCompleteConfiguration {
  apiBase: string;
  apiKey: string;
}

export class ConfigContainer {
  public config!: OpenAutoCompleteConfiguration;
}
