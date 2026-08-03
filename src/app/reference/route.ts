import { ApiReference } from "@scalar/nextjs-api-reference";

const config = {
  spec: {
    url: "/reference/spec",
  },
  theme: "purple" as const,
};

export const GET = ApiReference(config);
