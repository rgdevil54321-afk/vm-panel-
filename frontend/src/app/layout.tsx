import './globals.css'

export const metadata = {
  title: 'Tired AI',
  description: 'AI Assistant for Coding & Infrastructure',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
