// Адрес своего сервера «День». Пустая строка — сервер на том же адресе, что и приложение.
// Если приложение открывается с другого сайта (например, GitHub Pages), впишите сюда https-адрес сервера.
window.DAY_SERVER = {
  url: '',
  vapidPublicKey: '', // push-уведомления при закрытом приложении отложены до отдельного этапа
  // Прежнее облако Supabase — только для одноразового переноса поручений и записей при первом входе (этап 5).
  // Anon-ключ публичный по замыслу: доступ к данным в Supabase ограничен правилами RLS, читать можно только своё.
  oldSupabase: {
    url: 'https://axpglqvvevwttpnmuvam.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4cGdscXZ2ZXZ3dHRwbm11dmFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4OTQ1NzcsImV4cCI6MjEwNzQ3MDU3N30.yYEfCSRZArdKycDAT-LQal9xHY5D2ZN048Ax6ptJVWU'
  }
};
