const LIMITS = { name: 100, phone: 50, message: 2000 };

const form = document.getElementById("lead-form");
const receipt = document.getElementById("receipt");
const alertBox = document.getElementById("form-alert");
const submit = document.getElementById("submit");
const message = document.getElementById("message");
const messageCount = document.getElementById("message-count");

const charCount = (text) => [...text].length;

function showFieldError(field, text) {
  const error = document.getElementById(`${field}-error`);
  error.textContent = text;
  error.hidden = false;
  form.elements[field]?.setAttribute?.("aria-invalid", "true");
}

function clearErrors() {
  alertBox.hidden = true;
  for (const error of form.querySelectorAll(".field-error")) error.hidden = true;
  for (const input of form.querySelectorAll("[aria-invalid]")) input.removeAttribute("aria-invalid");
}

function readForm() {
  const data = new FormData(form);
  return {
    name: data.get("name"),
    email: data.get("email"),
    phone: data.get("phone"),
    service: data.get("service") ?? "",
    message: data.get("message"),
  };
}

/** Quick checks for instant feedback. The server applies the full rules. */
function checkLead(lead) {
  const errors = {};
  if (!lead.name.trim()) errors.name = "Enter your name.";
  else if (charCount(lead.name) > LIMITS.name) errors.name = `Keep your name to ${LIMITS.name} characters.`;
  if (!lead.email.trim()) errors.email = "Enter your email address.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) errors.email = "Enter an email address like ana@example.com.";
  if (charCount(lead.phone) > LIMITS.phone) errors.phone = `Keep your phone number to ${LIMITS.phone} characters.`;
  if (!lead.service) errors.service = "Choose a type of service.";
  if (!lead.message.trim()) errors.message = "Tell us about the job.";
  else if (charCount(lead.message) > LIMITS.message) errors.message = `Keep this to ${LIMITS.message} characters.`;
  return errors;
}

function focusField(field) {
  const target = field === "service" ? form.querySelector('input[name="service"]') : form.elements[field];
  target?.focus();
}

function updateMessageCount() {
  const used = charCount(message.value);
  messageCount.hidden = used < LIMITS.message - 200;
  messageCount.textContent = `${used} of ${LIMITS.message} characters`;
  messageCount.classList.toggle("over", used > LIMITS.message);
}

function showReceipt(lead) {
  document.getElementById("receipt-title").textContent = `Thanks, ${lead.name}.`;
  document.getElementById("receipt-detail").textContent = `Your request number is ${lead.id}. We'll reply to ${lead.email}.`;
  form.hidden = true;
  receipt.hidden = false;
  receipt.focus();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearErrors();

  const lead = readForm();
  const errors = Object.entries(checkLead(lead));
  if (errors.length) {
    for (const [field, text] of errors) showFieldError(field, text);
    focusField(errors[0][0]);
    return;
  }

  submit.disabled = true;
  submit.textContent = "Sending";
  try {
    const response = await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lead),
    });
    const body = await response.json();
    if (response.status === 201) {
      showReceipt(body);
      return;
    }
    const field = body.error?.match(/^(name|email|phone|service|message)\b/)?.[1];
    if (field) {
      showFieldError(field, body.error[0].toUpperCase() + body.error.slice(1));
      focusField(field);
    } else {
      alertBox.textContent = body.error || "The request was not sent. Try again.";
      alertBox.hidden = false;
    }
  } catch {
    alertBox.textContent = "The request was not sent. Check your connection and try again. Your details are still here.";
    alertBox.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = "Send request";
  }
});

message.addEventListener("input", updateMessageCount);

document.getElementById("another").addEventListener("click", () => {
  form.reset();
  updateMessageCount();
  receipt.hidden = true;
  form.hidden = false;
  form.elements.name.focus();
});
