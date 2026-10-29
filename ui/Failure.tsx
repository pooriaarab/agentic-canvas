import { Button } from "agentic-design/react";

export function Failure({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div role="alert" className="failure">
      <p><strong>Something went wrong.</strong> {message}</p>
      <Button variant="secondary" onClick={retry}>Try again</Button>
    </div>
  );
}
