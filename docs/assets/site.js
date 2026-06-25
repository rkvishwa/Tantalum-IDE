const header = document.querySelector("[data-site-header]");
const navToggle = document.querySelector("[data-nav-toggle]");
const siteNav = document.querySelector("[data-site-nav]");

const updateHeaderState = () => {
  if (!header) {
    return;
  }
  header.classList.toggle("is-scrolled", window.scrollY > 8);
};

const closeNavigation = () => {
  document.body.classList.remove("nav-open");
  navToggle?.setAttribute("aria-expanded", "false");
};

navToggle?.addEventListener("click", () => {
  const isOpen = document.body.classList.toggle("nav-open");
  navToggle.setAttribute("aria-expanded", String(isOpen));
});

siteNav?.addEventListener("click", (event) => {
  if (event.target instanceof HTMLAnchorElement) {
    closeNavigation();
  }
});

window.addEventListener("scroll", updateHeaderState, { passive: true });
window.addEventListener("resize", () => {
  if (window.innerWidth > 820) {
    closeNavigation();
  }
});

// Scrollspy Intersection Observer Implementation
const setupScrollspy = () => {
  const sidebarLinks = document.querySelectorAll(".sidebar-link");
  const sections = document.querySelectorAll(".docs-section");
  const topNavLinks = document.querySelectorAll(".site-nav a");

  if (!sections.length) return;

  const observerOptions = {
    root: null,
    rootMargin: "-25% 0px -55% 0px", // Trigger active state when section enters upper-middle screen
    threshold: 0
  };

  const observerCallback = (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const activeId = entry.target.getAttribute("id");

        // Highlight active sidebar links
        sidebarLinks.forEach((link) => {
          const href = link.getAttribute("href");
          link.classList.toggle("active", href === `#${activeId}`);
        });

        // Highlight active top navbar links
        topNavLinks.forEach((link) => {
          const href = link.getAttribute("href");
          link.classList.toggle("active", href === `#${activeId}` || href === `index.html#${activeId}`);
        });
      }
    });
  };

  const observer = new IntersectionObserver(observerCallback, observerOptions);
  sections.forEach((section) => observer.observe(section));
};

updateHeaderState();
document.addEventListener("DOMContentLoaded", setupScrollspy);
// Run immediately if page is already loaded
if (document.readyState === "interactive" || document.readyState === "complete") {
  setupScrollspy();
}
