import { SignOutForm } from "../sign-out-form";

export default function DemoLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SignOutForm />
      {children}
    </>
  );
}
