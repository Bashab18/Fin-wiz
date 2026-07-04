// Toggle collapsible sections
function toggleSection(button) {
    const content = button.nextElementSibling;
    const icon = button.querySelector('.toggle-icon');

    if (content.classList.contains('active')) {
        content.style.maxHeight = null;
        content.classList.remove('active');
        icon.textContent = '∨';
    } else {
        content.classList.add('active');
        content.style.maxHeight = content.scrollHeight + 'px';
        icon.textContent = '∧';
    }
}

// Animate progress bar on page load using real user data
document.addEventListener('DOMContentLoaded', function() {
    const progressBar = document.querySelector('.progress-bar');
    if (progressBar) {
        progressBar.style.width = '0%';
        DigifinwizDB.getUserData().then(function(data) {
            if (!data) return;
            var pct = Math.max(0, Math.min(100, Math.round(((1000 - (data.pointsToNextLevel || 1000)) / 1000) * 100)));
            setTimeout(function() { progressBar.style.width = pct + '%'; }, 300);
        }).catch(function() {});
    }

    // Hamburger menu toggle
    const navToggle = document.querySelector('.nav-toggle');
    const navMenu = document.querySelector('.nav-menu');
    if (navToggle && navMenu) {
        navToggle.addEventListener('click', function() {
            navMenu.classList.toggle('open');
            this.classList.toggle('active');
        });
    }

    // Add click handlers for expandable sidebar items
    const expandableItems = document.querySelectorAll('.nav-item.expandable');
    expandableItems.forEach(item => {
        item.addEventListener('click', function(e) {
            e.preventDefault();
            const arrow = this.querySelector('.arrow');
            if (arrow.textContent === '∨') {
                arrow.textContent = '∧';
            } else {
                arrow.textContent = '∨';
            }
        });
    });

    // Add hover effects to video cards
    const videoCards = document.querySelectorAll('.video-card');
    videoCards.forEach(card => {
        card.addEventListener('click', function() {
            showVideoModal(this);
        });
    });

    // Add click handlers for challenge buttons
    const tutorialButtons = document.querySelectorAll('.btn-navy');
    tutorialButtons.forEach(button => {
        if (button.textContent.includes('View a tutorial')) {
            button.addEventListener('click', function(e) {
                e.preventDefault();
                alert('Tutorial video would play here. This is a prototype.');
            });
        }
    });

    // Interactive credit cards (click toggle, not hover)
    const creditCards = document.querySelectorAll('.credit-card');
    creditCards.forEach(card => {
        card.addEventListener('click', function() {
            this.style.transform = this.style.transform === 'scale(1.02)' ? 'scale(1)' : 'scale(1.02)';
            setTimeout(() => {
                this.style.transform = 'scale(1)';
            }, 200);
        });
    });

    // Animate bar chart on scroll
    const barChart = document.querySelector('.bar-chart');
    if (barChart) {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const bars = entry.target.querySelectorAll('.bar');
                    bars.forEach((bar, index) => {
                        setTimeout(() => {
                            bar.style.opacity = '0';
                            bar.style.transform = 'translateY(20px)';
                            bar.style.transition = 'all 0.5s ease';
                            setTimeout(() => {
                                bar.style.opacity = '1';
                                bar.style.transform = 'translateY(0)';
                            }, 50);
                        }, index * 100);
                    });
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.5 });

        observer.observe(barChart);
    }

    // Page entrance animations - staggered fadeInUp on main content children
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
        const children = mainContent.children;
        Array.from(children).forEach((child, index) => {
            child.style.opacity = '0';
            child.style.animation = `fadeInUp 0.5s ease forwards`;
            child.style.animationDelay = `${index * 0.08}s`;
        });
    }

    // Smooth scrolling for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const href = this.getAttribute('href');
            if (href !== '#' && href.length > 1) {
                e.preventDefault();
                const target = document.querySelector(href);
                if (target) {
                    target.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start'
                    });
                }
            }
        });
    });

    // Notification system using CSS classes
    window.showNotification = function(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        document.body.appendChild(notification);

        setTimeout(() => {
            notification.classList.add('notification-exit');
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, 3000);
    };

    // ── Admin Inbox (participants only) ──────────────────────────────────────
    (function loadInbox() {
        if (typeof DigifinwizAuth === 'undefined' || typeof DigifinwizDB === 'undefined') return;
        var session = DigifinwizAuth.getSession();
        if (!session || !session.loggedIn || session.role !== 'participant') return;

        DigifinwizDB.init().then(function() {
            return DigifinwizDB.getMessagesForUser(session.userId);
        }).then(function(messages) {
            if (!messages.length) return;
            var section   = document.getElementById('inboxSection');
            var container = document.getElementById('inboxMessages');
            var badge     = document.getElementById('inboxUnreadBadge');
            if (!section || !container) return;
            section.style.display = '';

            var TYPE_LABEL = { announcement: '📣 Announcement', warning: '⚠️ Warning', info: 'ℹ️ Info' };
            var TYPE_CLASS = { announcement: 'msg-type-announcement', warning: 'msg-type-warning', info: 'msg-type-info' };

            function esc(s) {
                return s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            }

            function updateBadge(msgs) {
                var unread = msgs.filter(function(m) { return (m.readBy||[]).indexOf(session.userId) === -1; }).length;
                if (badge) { badge.textContent = unread; badge.style.display = unread > 0 ? '' : 'none'; }
            }

            function render(msgs) {
                updateBadge(msgs);
                container.innerHTML = '';
                msgs.forEach(function(m) {
                    var isRead    = (m.readBy || []).indexOf(session.userId) !== -1;
                    var typeClass = TYPE_CLASS[m.type] || 'msg-type-info';
                    var typeLabel = TYPE_LABEL[m.type] || m.type;
                    var card = document.createElement('div');
                    card.className = 'inbox-message ' + (isRead ? 'msg-read' : 'msg-unread');
                    card.innerHTML =
                        '<div class="inbox-msg-header">' +
                            '<span class="msg-type-badge ' + typeClass + '">' + esc(typeLabel) + '</span>' +
                            '<span class="inbox-msg-subject">' + esc(m.subject) + '</span>' +
                            (!isRead ? '<span class="nav-badge" style="font-size:0.65rem;padding:1px 6px">New</span>' : '') +
                        '</div>' +
                        '<div class="inbox-msg-meta">From <strong>' + esc(m.senderName) + '</strong> · ' + esc(new Date(m.sentAt).toLocaleString()) + '</div>' +
                        '<div class="inbox-msg-body" id="imb-' + m.id + '">' + esc(m.body) + '</div>' +
                        '<div class="inbox-msg-actions">' +
                            '<button class="btn btn-sm" onclick="inboxToggle(' + m.id + ')">Show / Hide</button>' +
                            (!isRead ? '<button class="btn btn-primary btn-sm" onclick="inboxRead(' + m.id + ')">Mark as Read</button>'
                                     : '<span style="font-size:0.75rem;color:#94a3b8">Read ✓</span>') +
                        '</div>';
                    container.appendChild(card);
                });
            }

            render(messages);

            window.inboxToggle = function(id) {
                var el = document.getElementById('imb-' + id);
                if (el) el.classList.toggle('expanded');
            };

            window.inboxRead = function(id) {
                DigifinwizDB.markMessageRead(id, session.userId).then(function() {
                    return DigifinwizDB.getMessagesForUser(session.userId);
                }).then(render).catch(console.error);
            };
        }).catch(console.error);
    })();

    // Add click feedback for all buttons
    document.querySelectorAll('.btn').forEach(button => {
        button.addEventListener('click', function(e) {
            // Only prevent default on <a> tags acting as buttons (no real href),
            // never on <button> or <input type="submit"> so forms still submit.
            if (this.tagName === 'A' && (!this.href || this.href === '#' || this.href.endsWith('#'))) {
                e.preventDefault();
            }

            const ripple = document.createElement('span');
            ripple.style.cssText = `
                position: absolute;
                border-radius: 50%;
                background: rgba(255,255,255,0.6);
                width: 100px;
                height: 100px;
                margin-top: -50px;
                margin-left: -50px;
                animation: ripple 0.6s;
                pointer-events: none;
            `;

            const rect = this.getBoundingClientRect();
            ripple.style.left = e.clientX - rect.left + 'px';
            ripple.style.top = e.clientY - rect.top + 'px';

            this.style.position = 'relative';
            this.style.overflow = 'hidden';
            this.appendChild(ripple);

            setTimeout(() => {
                ripple.remove();
            }, 600);
        });
    });

    // Initialize collapsible sections with proper max-height
    document.querySelectorAll('.collapsible-content.active').forEach(content => {
        content.style.maxHeight = content.scrollHeight + 'px';
    });

    // Initialize IndexedDB, seed default user data if needed, then update UI
    DigifinwizDB.init().then(() => {
        return DigifinwizDB.getUserData();
    }).then(data => {
        if (!data) {
            // Seed default user profile
            const defaultUser = {
                level: 13,
                points: 1390,
                pointsToNextLevel: 345,
                challenges: 5,
                completedTasks: 8
            };
            return DigifinwizDB.setUserData(defaultUser).then(() => defaultUser);
        }
        return data;
    }).then(data => {
        updateUIWithData(data);
        updateSidebarBadges();
        updateChallengeStats();
    }).catch(err => {
        console.error('DigifinwizDB init error:', err);
    });
});

// Video modal function
function showVideoModal(videoCard) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.9);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        animation: fadeIn 0.3s;
    `;

    const modalContent = document.createElement('div');
    modalContent.style.cssText = `
        background: white;
        padding: 2rem;
        border-radius: 12px;
        max-width: 600px;
        text-align: center;
    `;

    const title = videoCard.querySelector('h4').textContent;
    modalContent.innerHTML = `
        <h2 style="margin-bottom: 1rem;">${title}</h2>
        <p style="color: #64748b; margin-bottom: 2rem;">This is a prototype. Video player would appear here.</p>
        <button class="btn btn-navy" onclick="this.closest('.modal').remove()">Close</button>
    `;

    modal.appendChild(modalContent);
    document.body.appendChild(modal);

    modal.addEventListener('click', function(e) {
        if (e.target === modal) {
            modal.remove();
        }
    });
}

// Function to update progress - now uses IndexedDB
function updateProgress(points) {
    DigifinwizDB.getUserData().then(data => {
        if (!data) return;
        data.points += points;
        data.pointsToNextLevel -= points;

        if (data.pointsToNextLevel <= 0) {
            if (data.level === 1) {
                return DigifinwizDB.getLevel1Requirements().then(function(req) {
                    if (req.allMet) {
                        data.level++;
                        data.pointsToNextLevel = 1000;
                        showNotification(`Congratulations! You leveled up to level ${data.level}!`, 'success');
                    } else {
                        data.pointsToNextLevel = 0;
                    }
                    return DigifinwizDB.setUserData(data).then(() => { updateUIWithData(data); });
                });
            }
            data.level++;
            data.pointsToNextLevel = 1000;
            showNotification(`Congratulations! You leveled up to level ${data.level}!`, 'success');
        }

        return DigifinwizDB.setUserData(data).then(() => {
            updateUIWithData(data);
        });
    }).catch(err => console.error('updateProgress error:', err));
}

// Function to update UI with data object
function updateUIWithData(data) {
    if (!data) return;

    // Update stat cards if they exist
    const statNumbers = document.querySelectorAll('.stat-number');
    if (statNumbers.length > 0) {
        statNumbers[0].textContent = data.level;
        statNumbers[1].textContent = data.points.toLocaleString();
        // statNumbers[2] = challenges completed — updated dynamically by updateChallengeStats()
        statNumbers[3].textContent = data.completedTasks;
    }

    // Update progress header
    const progressHeader = document.querySelector('.progress-header h1');
    if (progressHeader) {
        progressHeader.textContent = `${data.pointsToNextLevel} Points to go before you level up to level ${data.level + 1}, good job!`;
    }

    // Update sidebar user name/username if profile data exists
    DigifinwizDB.getProfileData().then(function(prof) {
        if (!prof) return;
        var h3 = document.querySelector('.user-profile h3');
        var un = document.querySelector('.user-profile .username');
        var avatar = document.querySelector('.user-profile .avatar img');
        if (h3 && prof.fullName) h3.textContent = prof.fullName;
        if (un && prof.username) un.textContent = prof.username;
        if (avatar && prof.fullName) {
            var parts = prof.fullName.trim().split(' ');
            var initials = (parts[0] ? parts[0][0] : '?') + (parts[1] ? parts[1][0] : '');
            avatar.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect fill='%23667eea' width='80' height='80'/%3E%3Ctext x='50%25' y='50%25' font-size='32' fill='white' text-anchor='middle' dy='.3em'%3E" + encodeURIComponent(initials) + "%3C/text%3E%3C/svg%3E";
            avatar.alt = prof.fullName;
        }
    }).catch(function(){});
}

// Fetch challenge counts from DB and update the "Active Challenges" stat card
function updateChallengeStats() {
    if (typeof DigifinwizDB === 'undefined' || !DigifinwizDB.getChallenges) return;
    DigifinwizDB.getChallenges().then(function(challenges) {
        var active = challenges.filter(function(c){ return c.active; });
        var incomplete = active.filter(function(c){ return !c.completed; });

        var statNumbers = document.querySelectorAll('.stat-number');
        if (statNumbers.length > 2) {
            statNumbers[2].textContent = incomplete.length;
        }

        var statLabels = document.querySelectorAll('.stat-label');
        if (statLabels.length > 2) {
            statLabels[2].textContent = 'Active Challenges';
        }
    }).catch(function(){});
}

// Update sidebar nav-badge counts based on incomplete challenges per category
function updateSidebarBadges() {
    if (typeof DigifinwizDB === 'undefined' || !DigifinwizDB.getChallenges) return;
    DigifinwizDB.getChallenges().then(function(challenges) {
        var active = challenges.filter(function(c){ return c.active && !c.completed; });
        var byCategory = { ecommerce: 0, banking: 0, utilities: 0 };
        active.forEach(function(c) {
            if (byCategory.hasOwnProperty(c.category)) byCategory[c.category]++;
        });

        var ecoBadge = document.getElementById('sidebarBadgeEcommerce');
        var bankBadge = document.getElementById('sidebarBadgeBanking');
        var utilBadge = document.getElementById('sidebarBadgeUtilities');

        if (ecoBadge) {
            ecoBadge.textContent = byCategory.ecommerce;
            ecoBadge.style.display = byCategory.ecommerce > 0 ? '' : 'none';
        }
        if (bankBadge) {
            bankBadge.textContent = byCategory.banking;
            bankBadge.style.display = byCategory.banking > 0 ? '' : 'none';
        }
        if (utilBadge) {
            utilBadge.textContent = byCategory.utilities;
            utilBadge.style.display = byCategory.utilities > 0 ? '' : 'none';
        }
    }).catch(function(){});
}

// Legacy updateUI - reads from IndexedDB
function updateUI() {
    DigifinwizDB.getUserData().then(data => {
        updateUIWithData(data);
    }).catch(err => console.error('updateUI error:', err));
}

console.log('Digifinwiz app loaded successfully!');
