import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

type FormFieldProps = {
  label: string;
  error?: string;
  children: ReactNode;
};

export function FormField({ label, error, children }: FormFieldProps) {
  return (
    <div className="ui-form-field">
      <label>{label}</label>
      {children}
      {error ? <span className="ui-form-field__error">{error}</span> : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} />;
}
