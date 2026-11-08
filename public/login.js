const form = document.getElementById("login-form");
const alertBox = document.getElementById("login-alert");
const submit = document.getElementById("login-submit");

function showAlert(text) {
  alertBox.textContent = text;
  alertBox.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  alertBox.hidden = true;

  const username = form.elements.username.value;
  const password = form.elements.password.value;
  if (!username || !password) {
    showAlert("Enter your username and password.");
    return;
  }

  submit.disabled = true;
  submit.textContent = "Signing in";
  try {
    const response = await fetch("/owner/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (response.ok) {
      location.assign("/dashboard");
      return;
    }
    const body = await response.json();
    showAlert(body.error || "Sign in failed. Try again.");
    form.elements.password.select();
  } catch {
    showAlert("Sign in failed. Check your connection and try again.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Sign in";
  }
});
