import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { setAuthExpiredListener } from "@/platform/auth/session";
import { feedbackSink } from "@/platform/feedback/feedbackState";
import { setFeedbackSink } from "@/platform/feedback/feedbackBus";
import { getAppRoutePath } from "@/app/routes/manifest";
import { useAuthStore } from "@/stores/auth";
import router from "./router";
import "./style/materialSymbols.css";
import "./style/index.css";

// 导入懒加载指令
import lazyDirective from "./directives/lazy";

const app = createApp(App);
const pinia = createPinia();
const authStore = useAuthStore(pinia);

setFeedbackSink(feedbackSink);
setAuthExpiredListener(() => {
	authStore.logout();

	const currentRoute = router.currentRoute.value;
	if (currentRoute.name === "Login") {
		return;
	}

	const redirectTarget =
		typeof currentRoute.fullPath === "string" && currentRoute.fullPath.startsWith("/")
			? currentRoute.fullPath
			: getAppRoutePath("dashboard");

	void router
		.replace({
			name: "Login",
			query: {
				redirect: redirectTarget,
			},
		})
		.catch(() => undefined);
});

// 注册全局指令
app.directive("lazy", lazyDirective);

app.use(pinia);
app.use(router);
app.mount("#app");
