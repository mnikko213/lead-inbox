const form = document.getElementById("login-form");
const alertBox = document.getElementById("login-alert");
const submit = document.getElementById("login-submit");
const reveal = document.getElementById("reveal");
const password = form.elements.password;

function showAlert(text) {
  alertBox.textContent = text;
  alertBox.hidden = false;
}

function setSigningIn(signingIn) {
  submit.disabled = signingIn;
  submit.classList.toggle("is-busy", signingIn);
  submit.textContent = signingIn ? "Signing in" : "Sign in";
}

reveal.addEventListener("click", () => {
  const showing = password.type === "text";
  password.type = showing ? "password" : "text";
  reveal.textContent = showing ? "Show" : "Hide";
  reveal.setAttribute("aria-pressed", String(!showing));
  password.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  alertBox.hidden = true;

  const username = form.elements.username.value;
  if (!username || !password.value) {
    showAlert("Enter your username and password.");
    (username ? password : form.elements.username).focus();
    return;
  }

  setSigningIn(true);
  try {
    const response = await fetch("/owner/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: password.value }),
    });
    if (response.ok) {
      location.assign("/dashboard");
      return;
    }
    const body = await response.json();
    showAlert(body.error || "Sign in failed. Try again.");
    password.select();
  } catch {
    showAlert("Sign in failed. Check your connection and try again.");
  } finally {
    setSigningIn(false);
  }
});
