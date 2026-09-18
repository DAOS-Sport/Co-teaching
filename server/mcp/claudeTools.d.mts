export declare const tools: any[];

export declare function callTool(
  name: string,
  args?: Record<string, unknown>,
): Promise<unknown>;

export declare function textResult(
  value: unknown,
  isError?: boolean,
): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export declare function errorResult(error: unknown): ReturnType<typeof textResult>;