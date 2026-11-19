/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import ical, { ICalAttendeeData, ICalCategory, ICalEventClass, ICalEventStatus } from 'ical-generator';
import fetchLogin, { LoginError, LoginResponse } from './login';
import moment from 'moment';
import fetchTimes, { TimeSchema } from './times';
import fetchTimetable, { lesson, subject, Teacher } from './timetable';

function TimeMap(time: TimeSchema[]) {
	const timeMap = new Map<number, TimeSchema>();
	time.forEach((time) => {
		timeMap.set(time.id, time);
	});
	return timeMap;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const params = new URL(request.url).searchParams;
		const username = params.get('username');
		const password = params.get('password');
		const changes = parsebool(params.get('changes'));

		if (!username || !password) {
			return new Response('Missing username or password', { status: 400 });
		}
		// Fetch the JWT token
		let login: LoginResponse;
		try {
			login = await fetchLogin(username, password);
		} catch (error) {
			if (error instanceof LoginError) return new Response(error.message, { status: error.status });
			throw error;
		}
		const jwt = login.jwt;
		const studentId = login.user.associatedStudent?.id;
		if (!studentId) return new Response('Student ID not found', { status: 401 });

		const start = moment().subtract(2, 'week').startOf('week').format('YYYY-MM-DD');
		const end = moment().add(2, 'week').endOf('week').format('YYYY-MM-DD');

		const Times = await fetchTimes(jwt);
		const Timemap = TimeMap(Times?.results[0]?.data || []);
		if (!Timemap) return new Response('Failed to fetch times', { status: 500 });

		const Timetable = await fetchTimetable(jwt, studentId, start, end);
		if (!Timetable) return new Response('Failed to fetch lessons', { status: 500 });

		const calendar = ical({ name: 'Stundenplan' });
		const category = new ICalCategory({
			name: 'Schulmanager',
		});
		Timetable.results[0].data.forEach((lesson) => {
			const startTime = moment(lesson.date).startOf('day').add(Timemap.get(lesson.classHour.id)?.from, 'minutes');
			const endTime = moment(lesson.date).startOf('day').add(Timemap.get(lesson.classHour.id)?.until, 'minutes');
			// console.log('Start Time:', startTime.toDate());
			// console.log('End Time:', endTime.toDate());
			// console.log(lesson.actualLesson?.room);
			if (changes === true && lesson.type !== 'changedLesson') return;
			if (changes === false && lesson.type === 'changedLesson') return;
			calendar.createEvent({
				start: startTime.toDate(),
				end: endTime.toDate(),
				summary: (lesson.type === 'changedLesson' ? '(Changed) ' : '') + formatSubject(lesson),
				attendees: formatTeachers(lesson),
				timezone: 'Europe/Berlin',
				organizer: {
					email: `${lesson.actualLesson?.teachers[0].firstname} ${lesson.actualLesson?.teachers[0].lastname}`,
					name: `${lesson.actualLesson?.teachers[0].firstname} ${lesson.actualLesson?.teachers[0].lastname}`,
				},
				location: formatRoom(lesson),
				categories: [category],
				status: getStatus(lesson),
			});
		});

		return new Response(calendar.toString(), {
			headers: {
				'Content-Type': 'text/calendar',
				'Cache-Control': 'no-cache',
				'Content-Disposition': 'inline; filename="calendar.ics"',
			},
		});
	},
} satisfies ExportedHandler<Env>;

function getStatus(lesson: lesson) {
	if (lesson.actualLesson?.room.name === 'EVA') return ICalEventStatus.CANCELLED;
	if (lesson.type === 'cancelledLesson') return ICalEventStatus.CANCELLED;
	if (lesson.type === 'changedLesson') return ICalEventStatus.TENTATIVE;
	return ICalEventStatus.CONFIRMED;
}

function formatSubject(lesson: lesson) {
	const actualSubject = lesson.actualLesson?.subjectLabel || 'No subject assigned';
	const originalSubject = lesson.originalLessons?.map((subject) => subject.subjectLabel).join(', ') || 'No subject assigned';
	if (
		lesson.type === 'changedLesson' &&
		lesson.originalLessons &&
		lesson.originalLessons.length > 0 &&
		lesson.originalLessons[0]?.subject &&
		lesson.actualLesson?.subject.id !== lesson.originalLessons[0].subject.id
	) {
		return `${originalSubject} -> ${actualSubject}`;
	}

	return actualSubject;
}

function formatTeachers(lesson: lesson) {
	const output: ICalAttendeeData[] = [];

	lesson.actualLesson?.teachers.map((attendee) => {
		output.push({
			email: 'email',
			name: `${attendee.firstname} ${attendee.lastname}`,
		});
	});

	if (
		lesson.type === 'changedLesson' &&
		lesson.originalLessons &&
		lesson.originalLessons.length > 0 &&
		lesson.originalLessons[0]?.teachers &&
		lesson.actualLesson?.teachers !== lesson.originalLessons[0].teachers
	) {
		lesson.originalLessons[0].teachers.map((attendee) => {
			output.push({
				email: 'email',
				name: `normalerweise: ${attendee.firstname} ${attendee.lastname}`,
			});
		});
	}
	return output;
}

function formatRoom(lesson: lesson) {
	const actualRoom = lesson.actualLesson?.room.name || 'No room assigned';
	const originalRooms = lesson.originalLessons?.map((lesson) => lesson.room.name).join(', ') || 'No room assigned';
	if (
		lesson.type === 'changedLesson' &&
		lesson.originalLessons &&
		lesson.originalLessons.length > 0 &&
		lesson.originalLessons[0]?.room &&
		lesson.actualLesson?.room.id !== lesson.originalLessons[0].room.id
	) {
		return `${originalRooms} -> ${actualRoom}`;
	}
	return actualRoom;
}

function parsebool(string: string | null): boolean | null {
	if (string === 'true') return true;
	if (string === 'false') return false;
	return null;
}
