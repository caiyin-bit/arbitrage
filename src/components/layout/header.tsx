import { ThemeToggle } from "@/components/theme-toggle";

export function Header() {
  return (
    <header className="flex items-center justify-end h-14 px-6 border-b border-border">
      <ThemeToggle />
    </header>
  );
}
