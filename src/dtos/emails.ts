export interface ConfirmationAccountEmailProps {
  to: string;
  name: string;
  verificationCode: string;
}

export interface LoginUrlEmailProps {
  to: string;
  name: string;
  url: string;
}

export interface CredentialsEmailProps {
  to: string;
  name: string;
  clientId: string;
  clientSecret: string;
}