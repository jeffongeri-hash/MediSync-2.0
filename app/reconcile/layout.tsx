import { SignOutForm } from "../sign-out-form";

export default function ReconcileLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SignOutForm />
      {children}
    </>
  );
}
